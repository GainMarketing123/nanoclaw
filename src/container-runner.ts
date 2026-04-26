/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import http from 'http';

import {
  ATLAS_STATE_DIR,
  BRIDGE_CALLBACK_PORT,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  HOST_CLAUDE_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Path to the container log file, when available (for scope expansion detection) */
  logPath?: string;
  /**
   * True when the hard timeout fired and the container had to be reaped.
   * Codex round-2 on 7447453 finding 2 (SOFT, if_completeness): bridge needs
   * to distinguish hung-container timeouts from ordinary agent failures so it
   * can retry-with-longer-timeout / alert separately. The mission callback
   * status='timeout' value depends on this flag being threaded through.
   */
  timedOut?: boolean;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// ---------------------------------------------------------------------------
// Mission callback — notify bridge when a container finishes
// ---------------------------------------------------------------------------

const CALLBACK_SPOOL_DIR = path.join(DATA_DIR, 'bridge-callbacks');

interface MissionCallback {
  missionId: string;
  role: string;
  status: 'success' | 'error' | 'timeout';
  completedAt: string;
  error?: string;
  logPath?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * POST role completion to bridge HTTP endpoint. If bridge is down,
 * persist to disk for retry on next poll. Idempotent on (missionId, role).
 *
 * Per Codex architecture review: NanoClaw is the authority for container
 * terminal state. The bridge should not poll for this — push it.
 */
function notifyBridgeCallback(callback: MissionCallback): void {
  const payload = JSON.stringify(callback);

  // Codex round-3 on 4d6e9fe finding 1 (SOFT, concurrency): use ONE terminal-
  // state guard for ALL paths (success, non-2xx, error, timeout). Pre-fix the
  // round-2 spoolOnce dedup only covered error/timeout; the success path
  // logged-and-returned without marking settled, so a 2xx-headers-then-stall
  // sequence let the timeout event fire later and double-spool the callback —
  // bridge would see the same role-completion delivered + replayed from the
  // spool. Plus the response body was never drained, so Node's http client
  // could leave the request in a half-settled state where timeout fires
  // even though headers + 2xx already arrived.
  let terminal = false;
  const enterTerminal = (action: () => void) => {
    if (terminal) return;
    terminal = true;
    action();
  };

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: BRIDGE_CALLBACK_PORT,
      path: '/callback',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    },
    (res) => {
      // Codex round-4 on 2891bef finding 1 (SOFT, concurrency): make the
      // delivery decision on RESPONSE HEADERS, not on body-end. Pre-fix the
      // round-3 logic gated success on res.on('end'), so a slow-streaming
      // body could let the 5s request timeout fire BEFORE EOF — bridge had
      // already received and processed the POST (sent 2xx headers), but our
      // timeout handler would spool a duplicate. Headers-arrival is the
      // earliest unambiguous delivery signal; cancel the timeout immediately
      // and call enterTerminal based on statusCode. Body still drained via
      // res.resume() so Node frees the socket.
      req.setTimeout(0);
      res.resume();
      enterTerminal(() => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          logger.info(
            { missionId: callback.missionId, role: callback.role },
            'Bridge callback delivered',
          );
        } else {
          logger.warn(
            {
              missionId: callback.missionId,
              role: callback.role,
              status: res.statusCode,
            },
            'Bridge callback rejected (non-2xx), spooling for retry',
          );
          spoolCallback(callback);
        }
      });
      // Body-stream errors after the terminal decision are logged but cannot
      // change delivery outcome (enterTerminal would no-op on a re-entry).
      res.on('error', () => {
        enterTerminal(() => {
          logger.warn(
            { missionId: callback.missionId, role: callback.role },
            'Bridge response stream errored after headers, spooling for retry',
          );
          spoolCallback(callback);
        });
      });
    },
  );

  req.on('error', () => {
    enterTerminal(() => {
      logger.warn(
        { missionId: callback.missionId, role: callback.role },
        'Bridge unreachable, spooling callback for retry',
      );
      spoolCallback(callback);
    });
  });

  // Codex round-on-2702076 finding 2 (SOFT): Node http `timeout` option fires
  // the `timeout` event but does NOT auto-destroy or call error. We destroy
  // the request to free the socket; enterTerminal+the body-drain above
  // jointly prevent double-action.
  req.on('timeout', () => {
    enterTerminal(() => {
      logger.warn(
        { missionId: callback.missionId, role: callback.role },
        'Bridge callback timed out, spooling for retry',
      );
      spoolCallback(callback);
    });
    req.destroy(new Error('bridge callback timeout'));
  });

  req.write(payload);
  req.end();
}

/** Write callback to disk for retry when bridge comes back up */
function spoolCallback(callback: MissionCallback): void {
  try {
    fs.mkdirSync(CALLBACK_SPOOL_DIR, { recursive: true });
    const filename = `${callback.missionId}-${callback.role}-${Date.now()}.json`;
    // Atomic write: temp file then rename
    const tmpPath = path.join(CALLBACK_SPOOL_DIR, `.${filename}.tmp`);
    const finalPath = path.join(CALLBACK_SPOOL_DIR, filename);
    fs.writeFileSync(tmpPath, JSON.stringify(callback, null, 2));
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    logger.error(
      { missionId: callback.missionId, err },
      'Failed to spool bridge callback',
    );
  }
}

/**
 * Check if an IPC task payload is a bridge mission task.
 * Bridge tasks include a missionId and role in the prompt metadata.
 */
function parseMissionContext(
  prompt: string,
): { missionId: string; role: string } | null {
  // Bridge prefixes mission tasks with [Bridge Mission {id}]
  const match = prompt.match(/\[Bridge Mission (\S+)\]/);
  if (!match) return null;
  // Role is in the "Role: {name}" line
  const roleMatch = prompt.match(/Role:\s*(.+)/);
  return {
    missionId: match[1],
    role: roleMatch ? roleMatch[1].trim() : 'unknown',
  };
}

/**
 * Rewrite hook command paths from host (laptop or VPS) to container paths.
 * Host settings.json may use:
 *   Windows: "python C:/Users/ttle0/.atlas/hooks/foo.py"
 *   Linux:   "python3 /home/atlas/.atlas/hooks/foo.py"
 *   Override: "python3 /opt/atlas-state/hooks/foo.py" (ATLAS_DIR set)
 * Container needs: "python3 /home/node/.atlas/hooks/foo.py"
 *
 * Cross-review F1 fix on 3462d73: when ATLAS_STATE_DIR is overridden via
 * the ATLAS_DIR env var, the override path must also rewrite to the
 * container's /home/node/.atlas. Pre-fix the regex only matched HOME-
 * relative literal paths; an override like /opt/atlas-state would slip
 * through unchanged and the container would run hooks pointing at a
 * non-existent /opt/atlas-state inside the container namespace.
 */
function rewriteHookCommand(command: string): string {
  // Build a regex that matches the configured override path. Three normalizations:
  //   1. Strip trailing slashes (forward OR backslash) so we append /hooks|/lib explicitly.
  //   2. Convert backslashes to forward slashes so a Windows ATLAS_DIR like
  //      `D:\atlas-state` matches command strings spelled `D:/atlas-state` AND
  //      `D:\atlas-state` after we normalize the command too.
  //   3. Escape regex metacharacters so chars like '+' or '.' don't break matching.
  // Cross-review F1 fix on 3193244: pre-fix the regex was built from the raw
  // backslash string, so Windows operators with ATLAS_DIR set saw rewrites
  // silently no-op — container ran hooks pointing at host-only paths.
  const overrideRoot = ATLAS_STATE_DIR.replace(/[\\/]+$/, '').replace(
    /\\/g,
    '/',
  );
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Codex round-on-2702076 finding 3 (SOFT): the pre-fix line
  // `const cmd = command.replace(/\\/g, '/');` normalized backslashes
  // GLOBALLY across the entire command, mutating non-path Windows args
  // and quoted literals (any backslash anywhere in the command was rewritten,
  // not just backslashes in path positions). We now leave the command intact
  // and instead make each path regex accept BOTH separator styles via [\\/]
  // character classes at separator positions. Linux/macOS paths only ever
  // use forward slashes so those regexes are unchanged.

  let out = command
    // Normalize python → python3 (container has python3, not python)
    .replace(/^python\s/, 'python3 ')
    // Windows paths: accept C:\Users\xxx\.atlas\hooks\ OR C:/Users/xxx/.atlas/hooks/
    .replace(
      /[A-Za-z]:[\\/][^"'\s]*[\\/]\.atlas[\\/]hooks[\\/]/g,
      '/home/node/.atlas/hooks/',
    )
    .replace(
      /[A-Za-z]:[\\/][^"'\s]*[\\/]\.atlas[\\/]lib[\\/]/g,
      '/home/node/.atlas/lib/',
    )
    .replace(/[A-Za-z]:[\\/][^"'\s]*[\\/]\.claude[\\/]/g, '/home/node/.claude/')
    // Linux host paths: /home/<user>/.atlas/hooks/ → /home/node/.atlas/hooks/
    .replace(/\/home\/[^/]+\/\.atlas\/hooks\//g, '/home/node/.atlas/hooks/')
    .replace(/\/home\/[^/]+\/\.atlas\/lib\//g, '/home/node/.atlas/lib/')
    .replace(/\/home\/[^/]+\/\.claude\//g, '/home/node/.claude/');

  // Override-aware rewrite: if ATLAS_STATE_DIR resolves to something OTHER
  // than the home-relative default (e.g., the operator set ATLAS_DIR), also
  // map that root to the container's /home/node/.atlas. Skip when the
  // override resolves to an existing /home/<user>/.atlas because the
  // earlier replace above already covers that case.
  //
  // overrideRoot is forward-slashed; the command is NOT pre-normalized
  // (codex finding 3 fix). Build the override regex with [\\/] character
  // classes at separator positions so commands using either slash style
  // (D:/atlas-state/hooks/foo.py OR D:\atlas-state\hooks\foo.py) match.
  if (overrideRoot && !/^\/home\/[^/]+\/\.atlas$/.test(overrideRoot)) {
    // After escapeRe, '/' is still literal '/' (it's not a regex metachar).
    // Swap each '/' for [\\/] so the regex tolerates either separator style.
    const overrideAnyStyle = escapeRe(overrideRoot).replace(/\//g, '[\\\\/]');
    out = out
      .replace(
        new RegExp(`${overrideAnyStyle}[\\\\/]hooks[\\\\/]`, 'g'),
        '/home/node/.atlas/hooks/',
      )
      .replace(
        new RegExp(`${overrideAnyStyle}[\\\\/]lib[\\\\/]`, 'g'),
        '/home/node/.atlas/lib/',
      );
  }
  return out;
}

/**
 * Generate container settings.json with enforcement hooks and env vars.
 * Reads host ~/.claude/settings.json, rewrites paths for Linux container,
 * merges with required NanoClaw env vars. Regenerates when host settings change.
 */
function writeContainerSettings(settingsFile: string): void {
  const hostSettingsPath = path.join(HOST_CLAUDE_DIR, 'settings.json');

  // Required env vars for containers
  const containerEnv = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  };

  // If no host settings, write minimal config
  if (!fs.existsSync(hostSettingsPath)) {
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ env: containerEnv }, null, 2) + '\n',
      );
    }
    return;
  }

  // Check if host settings changed since last write
  const hostMtime = fs.statSync(hostSettingsPath).mtimeMs.toString();
  const markerFile = settingsFile + '.source-mtime';
  const cachedMtime = fs.existsSync(markerFile)
    ? fs.readFileSync(markerFile, 'utf-8').trim()
    : '';

  if (cachedMtime === hostMtime && fs.existsSync(settingsFile)) {
    return; // Host settings unchanged, skip regeneration
  }

  try {
    const hostSettings = JSON.parse(fs.readFileSync(hostSettingsPath, 'utf-8'));

    // Deep-clone hooks and rewrite all command paths
    const containerHooks: Record<string, unknown[]> = {};
    if (hostSettings.hooks && typeof hostSettings.hooks === 'object') {
      for (const [event, entries] of Object.entries(hostSettings.hooks)) {
        containerHooks[event] = (entries as Array<Record<string, unknown>>).map(
          (entry) => ({
            ...entry,
            hooks: ((entry.hooks as Array<Record<string, unknown>>) || []).map(
              (hook) => ({
                ...hook,
                command:
                  typeof hook.command === 'string'
                    ? rewriteHookCommand(hook.command)
                    : hook.command,
              }),
            ),
          }),
        );
      }
    }

    // Build container settings: hooks + merged env vars (no statusLine/spinnerVerbs/outputStyle)
    const containerSettings: Record<string, unknown> = {
      hooks: containerHooks,
      env: {
        ...(hostSettings.env || {}),
        ...containerEnv,
      },
    };

    fs.writeFileSync(
      settingsFile,
      JSON.stringify(containerSettings, null, 2) + '\n',
    );
    fs.writeFileSync(markerFile, hostMtime);

    logger.info(
      { settingsFile, hookEvents: Object.keys(containerHooks) },
      'Generated container settings.json with enforcement hooks',
    );
  } catch (err) {
    logger.warn(
      { error: err, hostSettingsPath },
      'Failed to read host settings, writing minimal container config',
    );
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ env: containerEnv }, null, 2) + '\n',
      );
    }
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Mount ~/.atlas READ-ONLY into the container for enforcement hooks.
  // Hooks use Path.home() / ".atlas" which resolves to /home/node/.atlas in container.
  // SECURITY: read-only prevents containers from modifying hooks, approval
  // queues, session tokens, or bridge config. Per adversarial review (Codex +
  // Claude cross-model consensus): "Remove writable ~/.atlas mounts from
  // containers before adding entity-scoped execution."
  // ATLAS_STATE_DIR picks up process.env.ATLAS_DIR override when set, so this
  // mount follows the same env-driven path as host-executor (1.A.6 decoupling).
  const atlasDir = ATLAS_STATE_DIR;
  if (fs.existsSync(atlasDir)) {
    mounts.push({
      hostPath: atlasDir,
      containerPath: '/home/node/.atlas',
      readonly: true,
    });
  }

  // Writable governance state directory — governance module writes audit logs,
  // quota tracking, and graduation status here. Separate from the read-only
  // ~/.atlas mount so containers can write state without accessing control plane.
  const govStateDir = path.join(DATA_DIR, 'governance-state', group.folder);
  fs.mkdirSync(govStateDir, { recursive: true });
  mounts.push({
    hostPath: govStateDir,
    containerPath: '/workspace/extra/atlas-state',
    readonly: false,
  });

  // Writable host-tasks directory — containers can request host-executor work
  // by writing JSON to this directory. Separate mount so the RO ~/.atlas
  // doesn't block host-task delegation.
  const hostTasksDir = path.join(ATLAS_STATE_DIR, 'host-tasks');
  fs.mkdirSync(path.join(hostTasksDir, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(hostTasksDir, 'completed'), { recursive: true });
  mounts.push({
    hostPath: hostTasksDir,
    containerPath: '/workspace/extra/atlas-state/host-tasks',
    readonly: false,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Generate settings.json with enforcement hooks.
  // Reads host settings.json, rewrites Windows paths to container Linux paths,
  // and merges with required env vars. Regenerated when host settings change.
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  writeContainerSettings(settingsFile);

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'files'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  // Always sync fresh source from the container image source.
  // Previous bug: only copied on first create (!fs.existsSync), so existing
  // groups kept running stale code forever after source updates.
  // Fix: compare a version marker and resync when source changes.
  if (fs.existsSync(agentRunnerSrc)) {
    const versionFile = path.join(groupAgentRunnerDir, '.source-hash');
    const sourceFiles = fs.readdirSync(agentRunnerSrc, {
      recursive: true,
    }) as string[];
    const sourceHash = sourceFiles
      .filter((f) => f.toString().endsWith('.ts'))
      .map((f) => {
        const stat = fs.statSync(path.join(agentRunnerSrc, f.toString()));
        return `${f}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
    const cachedHash = fs.existsSync(versionFile)
      ? fs.readFileSync(versionFile, 'utf-8').trim()
      : '';

    if (sourceHash !== cachedHash) {
      // Source changed — resync entire directory
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupAgentRunnerDir, '.source-hash'),
        sourceHash,
      );
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // SECURITY: All containers MUST route through the credential proxy.
  // No direct-auth bypass — containers never see real credentials.
  // The proxy injects API keys / OAuth tokens on the host side.
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;

  // SECURITY: Remove any .credentials.json from the group's .claude/ before
  // mounting. Containers must use the credential proxy, never direct auth.
  // The file could exist from a prior direct-auth session or manual scp.
  const groupClaudeDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  const staleCredsPath = path.join(groupClaudeDir, '.credentials.json');
  try {
    if (fs.existsSync(staleCredsPath)) {
      logger.warn(
        { group: group.name, path: staleCredsPath },
        'Removing .credentials.json from group .claude/ — containers must use proxy',
      );
      fs.unlinkSync(staleCredsPath);
    }
  } catch (err) {
    // ENOENT is fine — another concurrent launch may have already removed it
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const result = await new Promise<ContainerOutput>((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    // Codex round-2 on 7447453 finding 1 (BLOCKING, concurrency): the round-1
    // chain-isolation fix swallowed onOutput failures and resolved success
    // anyway. But onOutput is load-bearing — task-scheduler.ts uses it to send
    // the streamed result to the user, and index.ts uses it to persist session
    // IDs via setSession()/deleteSession(). A swallowed failure produces
    // false-positive success: tasks recorded complete though delivery or
    // persistence failed. Capture the FIRST callback error in outer scope so
    // the chain stays alive (subsequent outputs still process) but the close
    // path can resolve { status: 'error' } reflecting the real outcome.
    let firstCallbackError: Error | null = null;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            //
            // Codex round-on-2702076 finding 1 (BLOCKING, concurrency): wrap
            // the callback in try/catch INSIDE the chain so a rejected/throwing
            // onOutput cannot poison the chain. Pre-fix a single rejected
            // onOutput left outputChain in a rejected state, and the close
            // handlers below at L812 and L917 used `outputChain.then(() =>
            // resolve(...))` with no rejection branch — runContainerAgent()
            // hung forever. Wrapping here prevents the chain from ever seeing
            // the rejection; the .catch at the end is defense-in-depth in case
            // the wrapper itself synchronously throws.
            outputChain = outputChain
              .then(async () => {
                try {
                  await onOutput(parsed);
                } catch (callbackErr) {
                  // Round-2 fix: capture the FIRST error so the close path
                  // can resolve { status: 'error' } instead of false-positive
                  // success. Subsequent callbacks still run (chain stays
                  // alive), but only the first failure is reported in the
                  // resolved error message — the rest go to the warn log.
                  if (!firstCallbackError) {
                    firstCallbackError =
                      callbackErr instanceof Error
                        ? callbackErr
                        : new Error(String(callbackErr));
                  }
                  logger.warn(
                    { group: group.name, error: callbackErr },
                    'onOutput callback threw — captured for close-path error propagation',
                  );
                }
              })
              .catch(() => {
                // Defense in depth: keep the chain healthy even if try/catch missed.
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          // Codex round-on-2702076 finding 1 + round-2 on 7447453 finding 1:
          // defense-in-depth .catch keeps resolve() reachable, AND on
          // settlement we check firstCallbackError so a swallowed callback
          // failure (delivery to user, session persistence) propagates as
          // status:'error' rather than false-positive success.
          outputChain
            .catch(() => {})
            .then(() => {
              if (firstCallbackError) {
                logger.error(
                  { group: group.name, error: firstCallbackError },
                  'Container completed but onOutput callback failed — propagating as error',
                );
                resolve({
                  status: 'error',
                  result: null,
                  newSessionId,
                  error: `onOutput callback failed: ${firstCallbackError.message}`,
                });
              } else {
                resolve({
                  status: 'success',
                  result: null,
                  newSessionId,
                });
              }
            });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        // Codex round-2 on 7447453 finding 2: thread timedOut so the bridge
        // can distinguish hung-container timeouts from ordinary errors and
        // route to retry-with-longer-timeout / separate alert.
        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
          timedOut: true,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          logPath: logFile,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        // Codex round-on-2702076 finding 1 + round-2 on 7447453 finding 1:
        // defense-in-depth .catch keeps resolve() reachable; on settlement we
        // check firstCallbackError so a swallowed delivery/persistence
        // failure propagates as status:'error' rather than false-positive
        // success on the normal close path too.
        outputChain
          .catch(() => {})
          .then(() => {
            if (firstCallbackError) {
              logger.error(
                {
                  group: group.name,
                  duration,
                  newSessionId,
                  error: firstCallbackError,
                },
                'Container completed but onOutput callback failed — propagating as error',
              );
              resolve({
                status: 'error',
                result: null,
                newSessionId,
                error: `onOutput callback failed: ${firstCallbackError.message}`,
                logPath: logFile,
              });
            } else {
              logger.info(
                { group: group.name, duration, newSessionId },
                'Container completed (streaming mode)',
              );
              resolve({
                status: 'success',
                result: null,
                newSessionId,
                logPath: logFile,
              });
            }
          });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve({ ...output, logPath: logFile });
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
          logPath: logFile,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });

  // Post-completion: if this was a bridge mission task, notify the bridge
  const missionCtx = parseMissionContext(input.prompt);
  if (missionCtx) {
    const duration = Date.now() - startTime;
    // Codex round-2 on 7447453 finding 2 (SOFT, if_completeness): map the
    // ContainerOutput.timedOut flag to MissionCallback.status='timeout' so
    // the bridge can retry hung-container timeouts with a longer deadline /
    // alert separately. Pre-fix all non-success was collapsed to 'error',
    // and the declared 'timeout' status enum was never produced.
    const callbackStatus: 'success' | 'error' | 'timeout' = result.timedOut
      ? 'timeout'
      : result.status === 'success'
        ? 'success'
        : 'error';
    notifyBridgeCallback({
      missionId: missionCtx.missionId,
      role: missionCtx.role,
      status: callbackStatus,
      completedAt: new Date().toISOString(),
      error: result.error,
      logPath: result.logPath,
    });
    logger.info(
      { missionId: missionCtx.missionId, role: missionCtx.role, duration },
      'Mission role container completed',
    );
  }

  return result;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
