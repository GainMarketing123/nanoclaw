import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  GROUPS_DIR,
  HEALTH_PORT,
  HEALTH_STALL_THRESHOLD_MS,
  HEALTH_STARTUP_GRACE_MS,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import { recordLoopBeat } from './health.js';
import { startHealthServer } from './health-server.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  clearGroupIsMain,
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  isRetiredChannelJid,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import { handleCommand } from './commands.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { SecondBrainClient, parseLoomQuestion } from './secondbrain/client.js';
import {
  maybeHandleAskMessage,
  parseAskQuestion,
  senderIdentityFromMessage,
} from './secondbrain/askDispatch.js';
import { loadOwnerConfigFromEnv } from './secondbrain/owner.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// Loom (learning-brain) Q&A over Teams: a "loom ..." message is answered from
// the course brain instead of spawning the agent. Long timeout because a course
// answer runs Claude server-side (~20-40s); the 5s default would always trip.
// The SAME client also serves the owner-gated "/ask" all-entity Q&A below —
// one brain, one base URL, one secret, one timeout contract.
const _loomTimeoutRaw = Number(process.env.LOOM_BRAIN_TIMEOUT_MS);
// Loom brain config follows this repo's .env contract (the same SECOND_BRAIN_*
// keys .env.example documents): read from the project-root .env FILE via
// readEnvFile, NOT process.env. SECOND_BRAIN_API_KEY is a SECRET, and env.ts's
// explicit contract is to keep secrets in the file and out of process.env so
// they don't leak to child processes (same as ANTHROPIC_API_KEY / Teams creds).
// process.env still wins as an override for systemd EnvironmentFile= deploys;
// BRAIN_BASE_URL is a legacy fallback for installs that set it before the
// SECOND_BRAIN_BASE_URL rename. The API key MUST be passed through — the
// SecondBrainClient only sends the auth header when apiKey is set, so omitting
// it makes loom Q&A fail (or silently degrade) against a protected remote brain.
const _loomEnv = readEnvFile([
  'SECOND_BRAIN_BASE_URL',
  'SECOND_BRAIN_API_KEY',
  'BRAIN_BASE_URL',
]);
const LOOM_BRAIN = new SecondBrainClient(
  process.env.SECOND_BRAIN_BASE_URL ||
    _loomEnv.SECOND_BRAIN_BASE_URL ||
    process.env.BRAIN_BASE_URL ||
    _loomEnv.BRAIN_BASE_URL ||
    'http://127.0.0.1:8000',
  {
    timeoutMs: Number.isFinite(_loomTimeoutRaw) ? _loomTimeoutRaw : 45000,
    apiKey:
      process.env.SECOND_BRAIN_API_KEY ||
      _loomEnv.SECOND_BRAIN_API_KEY ||
      undefined,
  },
);
const LOOM_ENTITY_SLUG = process.env.LOOM_ENTITY_SLUG || 'learning';

// Owner identity for the "/ask" all-entity brain Q&A. Same env contract as
// the Teams channel's owner gate (ATLAS_OWNER_AAD_OBJECT_ID / ATLAS_OWNER_UPN,
// already documented in .env.example): process.env wins for systemd
// EnvironmentFile= deploys, the project .env file is the laptop default.
// If neither is set, loadOwnerConfigFromEnv returns an empty config and the
// gate inside handleOwnerAsk fails closed — "/ask" refuses EVERYONE.
const _askOwnerEnv = readEnvFile([
  'ATLAS_OWNER_AAD_OBJECT_ID',
  'ATLAS_OWNER_UPN',
]);
const ASK_OWNER = loadOwnerConfigFromEnv({
  ATLAS_OWNER_AAD_OBJECT_ID:
    process.env.ATLAS_OWNER_AAD_OBJECT_ID ||
    _askOwnerEnv.ATLAS_OWNER_AAD_OBJECT_ID,
  ATLAS_OWNER_UPN: process.env.ATLAS_OWNER_UPN || _askOwnerEnv.ATLAS_OWNER_UPN,
});

/**
 * Extract a human-readable entity label from a group folder name.
 * "atlas_main" → "Atlas", "atlas_gpg" → "GPG", "atlas_crownscape" → "Crownscape"
 */
function entityLabel(group: RegisteredGroup): string {
  const parts = group.folder.split('_');
  const last = parts[parts.length - 1];
  if (last === 'main') return 'Atlas';
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/**
 * Build a short summary from message content (first 80 chars, single line).
 */
function messageSummary(content: string, maxLen = 80): string {
  const clean = content
    .replace(new RegExp(`@${ASSISTANT_NAME}`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  // Defensive single-main normalization. setRegisteredGroup enforces a single
  // is_main=1 row on WRITE, but legacy data predating that invariant (e.g. a
  // Telegram main left behind after the Teams migration) could still carry two
  // is_main=1 rows. Without this, loadState would revive BOTH as isMain in
  // memory on every restart, re-creating the two-privileged-chats bug the
  // write-path guard fixes.
  //
  // Critically, the demotion must be PERSISTED, not just applied in memory: the
  // alert router (credential-proxy.ts) reads the DB directly with
  // `SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1`. With two
  // is_main=1 rows still on disk, that query's LIMIT 1 can pick the dead
  // (e.g. Telegram) main, so after a restart auth alerts route to a target that
  // no longer exists. An in-memory-only demotion never reaches that query.
  //
  // Which main survives must also be deterministic across restarts (SELECT
  // order is not stable across a SQLite vacuum/rewrite). We keep the canonical
  // `folder === 'main'` group when present — that is the row the schema
  // migration promotes (`UPDATE ... SET is_main = 1 WHERE folder = 'main'`) —
  // and otherwise fall back to the first main encountered. Every other main is
  // demoted in memory AND on disk.
  const mainJids = Object.entries(registeredGroups)
    .filter(([, group]) => group.isMain)
    .map(([jid]) => jid);
  if (mainJids.length > 1) {
    const keepJid =
      mainJids.find((jid) => registeredGroups[jid].folder === 'main') ??
      mainJids[0];
    for (const jid of mainJids) {
      if (jid === keepJid) continue;
      const group = registeredGroups[jid];
      logger.warn(
        { jid, name: group.name, keepJid },
        'Demoting duplicate is_main group on load (single-main invariant) — persisting to DB',
      );
      registeredGroups[jid] = { ...group, isMain: undefined };
      // Persist the demotion so the DB-backed alert router cannot revive it.
      clearGroupIsMain(jid);
    }
  }
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Invalidate sessions for groups whose CLAUDE.md has changed.
 * The SDK caches system prompts per session — if CLAUDE.md changes,
 * the old session still uses the old prompt. This detects changes
 * and clears stale sessions so the next container loads fresh.
 */
function invalidateStaleClaudeMdSessions(): void {
  const hashKey = 'claudemd_hashes';
  const stored = getRouterState(hashKey);
  let oldHashes: Record<string, string> = {};
  try {
    oldHashes = stored ? JSON.parse(stored) : {};
  } catch {
    /* reset on corruption */
  }

  const newHashes: Record<string, string> = {};
  let invalidated = 0;

  for (const [jid, group] of Object.entries(registeredGroups)) {
    try {
      const claudeMdPath = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
      if (!fs.existsSync(claudeMdPath)) continue;

      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      const hash = crypto.createHash('md5').update(content).digest('hex');
      newHashes[group.folder] = hash;

      if (oldHashes[group.folder] && oldHashes[group.folder] !== hash) {
        // CLAUDE.md changed — clear this group's session
        delete sessions[group.folder];
        deleteSession(group.folder);
        invalidated++;
        logger.info(
          { group: group.name, folder: group.folder },
          'CLAUDE.md changed — session invalidated for fresh system prompt',
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  if (
    invalidated > 0 ||
    JSON.stringify(newHashes) !== JSON.stringify(oldHashes)
  ) {
    setRouterState(hashKey, JSON.stringify(newHashes));
  }

  if (invalidated > 0) {
    logger.info({ count: invalidated }, 'Stale CLAUDE.md sessions invalidated');
  }
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  // Persist to the DB FIRST (atomic single-main transaction in
  // setRegisteredGroup), then mirror the result in memory only on success. If
  // the DB write throws, process memory is left untouched and stays consistent
  // with the database rather than being mutated ahead of a failed persist.
  setRegisteredGroup(jid, group);

  // Mirror the DB-layer single-main invariant in the in-memory map. The router
  // and command path trust `registeredGroups[chatJid]?.isMain`, not the DB, so
  // promoting a new main must demote every other in-memory entry too —
  // otherwise the old main keeps its privileges until process restart, leaving
  // two simultaneously-privileged chats in memory (out of sync with the DB,
  // which `setRegisteredGroup` keeps single-main).
  if (group.isMain) {
    for (const [otherJid, otherGroup] of Object.entries(registeredGroups)) {
      if (otherJid !== jid && otherGroup.isMain) {
        registeredGroups[otherJid] = { ...otherGroup, isMain: undefined };
      }
    }
  }
  registeredGroups[jid] = group;

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // 3d-1: Mechanical receive ack — fires synchronously before container spawn
  try {
    const entity = entityLabel(group);
    const summary = messageSummary(missedMessages[0].content);
    await channel.sendMessage(chatJid, `[${entity}] Received: ${summary}`);
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to send receive ack');
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);

  // 3d-3: Container spawn ack — tells user the agent is starting
  try {
    await channel.sendMessage(chatJid, 'Working on it...');
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to send spawn ack');
  }

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId === '__session_cleared__') {
          // Agent-runner detected stale session and self-healed — clear our side too
          delete sessions[group.folder];
          deleteSession(group.folder);
          logger.info(
            { group: group.name },
            'Stale session cleared by agent-runner (self-heal)',
          );
          return;
        }
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Self-heal: if error is session-related, clear stale session so next retry starts fresh
      const errText = output.error || '';
      if (
        errText.includes('No conversation found') ||
        errText.includes('session') ||
        errText.includes('Session')
      ) {
        delete sessions[group.folder];
        setSession(group.folder, '');
        logger.warn(
          { group: group.name },
          'Session-related error detected — cleared stale session for next retry',
        );
      }
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    // Heartbeat: stamp each iteration so /health can tell a wedged loop apart
    // from a live one. Recorded at the top of the body so reaching the next
    // pass proves the loop is iterating (and that the prior iteration's awaits
    // resolved). A wedge mid-iteration leaves this stale, which /health reports
    // as 503.
    recordLoopBeat();
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  invalidateStaleClaudeMdSessions();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start health endpoint (loopback) so the atlas-watchdog can detect an
  // internally-wedged process — the message loop stalling while the process
  // is still up — instead of only pgrep-ing for liveness. Best-effort: a
  // failure to bind the health port must not stop the orchestrator from
  // serving messages, so log and continue rather than crash.
  let healthServer: import('http').Server | null = null;
  try {
    healthServer = await startHealthServer(
      HEALTH_PORT,
      HEALTH_STALL_THRESHOLD_MS,
      HEALTH_STARTUP_GRACE_MS,
    );
  } catch (err) {
    logger.error({ err, port: HEALTH_PORT }, 'Failed to start health server');
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    healthServer?.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Atlas commands — intercept from main group before storage (zero LLM cost)
      if (registeredGroups[chatJid]?.isMain && trimmed.startsWith('/')) {
        const result = handleCommand(trimmed, msg.sender);
        if (result.handled && result.response) {
          const channel = findChannel(channels, chatJid);
          if (channel) {
            channel
              .sendMessage(chatJid, result.response)
              .catch((err) =>
                logger.error({ err, chatJid }, 'Command response send error'),
              );
          }
          return;
        }
      }

      // 3d-2: Failure ack — denied sender gets a specific reason, not silence.
      // MUST run before loom dispatch: a denied sender must not reach the
      // course-brain Q&A path (auth-bypass fix for F1 from d72146a cross-review).
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          // Send denial ack to the group
          const channel = findChannel(channels, chatJid);
          if (channel) {
            channel
              .sendMessage(
                chatJid,
                `Message from ${msg.sender_name || 'unknown sender'} — not on the approved sender list for this group.`,
              )
              .catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to send denial ack'),
              );
          }
          return;
        }
      }

      // Loom (learning-brain) course Q&A — "loom <question>" answers from the
      // course brain instead of the agent. Intercept before storage.
      const loomQuestion = parseLoomQuestion(trimmed);
      if (loomQuestion !== null) {
        const channel = findChannel(channels, chatJid);
        if (!loomQuestion) {
          channel
            ?.sendMessage(
              chatJid,
              'Ask your courses something, e.g. "loom how do I write a hook?"',
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Loom usage hint send error'),
            );
          return;
        }
        (async () => {
          await channel?.sendMessage(chatJid, '🎓 Searching your courses…');
          const result = await LOOM_BRAIN.askBySlug(
            LOOM_ENTITY_SLUG,
            loomQuestion,
          );
          const reply =
            !result.degraded && result.answer.trim()
              ? result.answer
              : 'Your course brain is catching up and could not answer that just now — try again in a moment.';
          await channel?.sendMessage(chatJid, reply);
        })().catch((err) =>
          logger.error({ err, chatJid }, 'Loom course Q&A error'),
        );
        return;
      }

      // Owner-gated all-entity brain Q&A — "/ask <question>". Same async
      // pattern as the loom dispatch above. Placement is load-bearing:
      //  - AFTER the main-group handleCommand dispatch: unknown commands
      //    (like /ask) return { handled: false } there and fall through, so
      //    /ask is never swallowed by an "unknown command" path.
      //  - AFTER the sender-allowlist denial: a denied sender must not reach
      //    the brain (mirrors the loom auth fix above).
      //  - BEFORE storeMessage: an /ask is answered here, not by the agent.
      // The owner gate is checked FIRST inside handleOwnerAsk (fail-closed);
      // the sender identity comes from the channel-verified fields on the
      // message (Teams populates them post-authentication; channels that
      // can't verify identity leave them unset and the gate refuses).
      if (parseAskQuestion(trimmed) !== null) {
        const channel = findChannel(channels, chatJid);
        maybeHandleAskMessage({
          text: trimmed,
          sender: senderIdentityFromMessage(msg),
          owner: ASK_OWNER,
          client: LOOM_BRAIN,
          send: async (text: string) => {
            await channel?.sendMessage(chatJid, text);
          },
          onError: (err) =>
            logger.error({ err, chatJid }, '/ask owner Q&A error'),
        }).catch((err) =>
          logger.error({ err, chatJid }, '/ask reply send error'),
        );
        return;
      }

      storeMessage(msg);
    },
    // Auto-register the owner's 1:1 chat as the main control group the first
    // time they message from an owner-gated channel (Teams). The channel has
    // already verified the sender is the owner (fail-closed gate), so this is
    // the sanctioned entry point — no second owner check is needed here. Without
    // it, owner messages are stored but never processed, because the message
    // loop only acts on JIDs present in registeredGroups. Idempotent: a chat
    // that is already registered is left untouched.
    ensureOwnerMainGroup: (chatJid: string) => {
      if (registeredGroups[chatJid]) return;
      registerGroup(chatJid, {
        name: 'Atlas',
        // MUST be 'atlas_main': the host-side IPC writers (host/host-executor.py
        // IPC_DIR and src/credential-proxy.ts) emit alert/result messages from a
        // hard-coded `data/ipc/atlas_main/messages` source, and startIpcWatcher
        // authorizes by SOURCE folder (folder===is_main folder). A divergent
        // folder here would make the main group's folder !== 'atlas_main', so
        // those CEO alerts (auth-expiry, outage, escalation, task results) would
        // be rejected as "Unauthorized IPC message attempt blocked" even though
        // the target JID resolves. 'atlas_main' also matches the name→folder
        // convention ("Atlas" ↔ atlas_main).
        folder: 'atlas_main',
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: true,
      });
      logger.info(
        { chatJid },
        'Owner chat auto-registered as main control group',
      );
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  // No channel owns this JID. Two cases, deliberately distinct:
  //
  //   (a) RETIRED channel (e.g. Telegram, removed 2026-06-03 — Teams is
  //       primary). Retired `tg:` group rows still live in the DB and an IPC
  //       consumer (e.g. the host-executor's auth-failure alert) may still
  //       target one. This absence is CORRECT, not a fault — throwing here
  //       surfaced a false "No channel for JID: tg:…" alarm in
  //       health/diagnostics. Warn-and-drop (best-effort fire-and-notify).
  //
  //   (b) ANY OTHER unowned JID — a live channel that is temporarily
  //       unmapped/misconfigured. This IS a fault: dropping it silently would
  //       lose a message destined for a real recipient AND (for documents)
  //       unlink the payload, with a FALSE "sent" success log, because the IPC
  //       watcher (src/ipc.ts) only preserves the IPC file to data/ipc/errors
  //       when the send THROWS. So for the non-retired case we keep throwing,
  //       preserving the original error-routing/retry contract.
  //
  // (cross-review 4ce737e F1: the first cut warn-dropped ALL unowned JIDs,
  // silently losing live-but-unmapped sends. Discriminate by retired prefix.)
  const handleNoChannel = (op: string, jid: string): void => {
    if (isRetiredChannelJid(jid)) {
      logger.warn(
        { jid, op },
        'No channel owns JID; dropping IPC send (expected — retired channel)',
      );
      return;
    }
    // Live-but-unmapped: surface so the IPC watcher routes the file to
    // data/ipc/errors instead of silently dropping it.
    throw new Error(`No channel for JID: ${jid}`);
  };
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        handleNoChannel('sendMessage', jid);
        return Promise.resolve();
      }
      return channel.sendMessage(jid, text);
    },
    sendDocument: (jid, filePath, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        handleNoChannel('sendDocument', jid);
        return Promise.resolve();
      }
      if (!channel.sendDocument) {
        // A LIVE channel that genuinely lacks document support is a real
        // capability error, distinct from an absent channel — keep throwing.
        throw new Error(
          `Channel ${channel.name} does not support sendDocument`,
        );
      }
      return channel.sendDocument(jid, filePath, options);
    },
    sendMessageWithKeyboard: (jid, text, buttons) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        handleNoChannel('sendMessageWithKeyboard', jid);
        return Promise.resolve();
      }
      // Use keyboard method if available, otherwise fall back to plain text
      if (channel.sendMessageWithKeyboard) {
        return channel.sendMessageWithKeyboard(jid, text, buttons);
      }
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
