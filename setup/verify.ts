/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { detectAuthMode } from '../src/credential-proxy.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import {
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

/** Inputs to the overall verify verdict — pure data, exported for tests. */
export interface VerifyStatusInputs {
  /** Service state: 'running' | 'stopped' | 'not_found'. */
  service: string;
  /** Credential state: 'configured' | 'missing'. */
  credentials: string;
  /** Per-channel auth map, e.g. { teams: 'configured', whatsapp: 'authenticated' }. */
  channelAuth: Record<string, string>;
  /** Count of rows in registered_groups. */
  registeredGroups: number;
}

/**
 * Teams success gate: Teams is the PRIMARY CEO command channel — owner
 * commands, mission approvals, escalation alerts, and host-task results all
 * land there. An install where another channel happens to be configured but
 * Teams is not (bot creds or owner identity missing) is not operational for
 * the CEO, so verify must NOT declare success for it. Channel detection
 * itself (section 4 above) already requires BOTH the bot credential triple
 * and an owner identity before reporting Teams configured.
 */
export function teamsGateSatisfied(
  channelAuth: Record<string, string>,
): boolean {
  return channelAuth.teams === 'configured';
}

/**
 * Compute the overall verify verdict. Pure — exported so the success gate is
 * unit-testable without execSync/launchctl/DB scaffolding.
 *
 * Success requires: service running, credentials present, the Teams gate
 * (see teamsGateSatisfied — any-channel-configured is NOT sufficient), and
 * at least one registered group.
 */
export function computeVerifyStatus(
  inputs: VerifyStatusInputs,
): 'success' | 'failed' {
  return inputs.service === 'running' &&
    inputs.credentials !== 'missing' &&
    teamsGateSatisfied(inputs.channelAuth) &&
    inputs.registeredGroups > 0
    ? 'success'
    : 'failed';
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  const mgr = getServiceManager();

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      if (output.includes('com.nanoclaw')) {
        // Check if it has a PID (actually running)
        const line = output.split('\n').find((l) => l.includes('com.nanoclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    // Check for nohup PID file
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('command -v container', { stdio: 'ignore' });
    containerRuntime = 'apple-container';
  } catch {
    try {
      execSync('docker info', { stdio: 'ignore' });
      containerRuntime = 'docker';
    } catch {
      // No runtime
    }
  }

  // 3. Check credentials
  //
  // AUTHORITATIVE on the Claude Code OAuth credential FILE — the exact source
  // the runtime inference paths read after the 2026-07-11 subscription cutover:
  //   - host/host-executor.py:_load_oauth_token (the Haiku quality-check gate), and
  //   - the credential proxy in OAuth mode
  // both read claudeAiOauth.accessToken from $CLAUDE_CONFIG_DIR/.credentials.json,
  // else $HOME/.claude/.credentials.json. Verify checks the SAME sources so a
  // green verdict cannot diverge from runtime.
  //
  // The prior env / ATLAS_DIR/.env API-token checks (CLAUDE_CODE_OAUTH_TOKEN /
  // ANTHROPIC_AUTH_TOKEN / the now-retired ANTHROPIC_API_KEY) are removed: none
  // are read by the inference gate, so accepting them produced a green verify
  // while every quality-check returned token_missing at runtime. The metered
  // anthropic-api-key systemd LoadCredential source is likewise gone.
  //
  // OPERATOR CONTRACT: verify resolves $CLAUDE_CONFIG_DIR/$HOME from ITS OWN
  // process env, which matches runtime only when run under the same identity
  // (or the same overrides) as the services. On the VPS the services'
  // effective credential root is /home/nanoclaw-he/.claude (atlas-user-split
  // drop-in HOME= for the host-executor; oauth-shared-identity drop-in
  // CLAUDE_CONFIG_DIR= for the orchestrator/proxy — see infra/systemd-dropins/).
  // Run verify as root/another operator with
  //   CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude
  // or its verdict describes the OPERATOR's credential, not the services'
  // (same convention as host/refresh-claude-auth.sh, which passes
  // CLAUDE_CONFIG_DIR explicitly to its post-write auth check).
  //
  // API-KEY MODE (codex review rounds 2+3 on the cutover branch — the two
  // findings pull opposite ways; this is the synthesis): the runtime still
  // supports api-key deployments for the PROXY/CONTAINER path —
  // detectAuthMode() (imported from credential-proxy so the two can never
  // drift) selects api-key mode whenever loadAnthropicApiKey() finds a key
  // (the documented cutover ROLLBACK lever and the supported
  // non-subscription mode). But the host quality-check gate
  // (host/host-executor.py:_call_haiku) is subscription-OAuth-ONLY by CEO
  // decision (2026-07-11 cutover — the metered key is never reintroduced
  // there). A key WITHOUT an OAuth credential therefore runs containers
  // fine while every CEO-facing quality check degrades to
  // unavailable/token_missing — that is NOT a fully configured install, so
  // verify stays FAIL-CLOSED: green requires the OAuth credential file.
  // The api-key detection below exists to make the failure mode legible
  // (named warning) instead of a bare credentials=missing, and to document
  // the valid rollback shape: key present AND OAuth file present (proxy
  // uses the key, quality gate uses OAuth) IS green — via the file check.
  let credentials = 'missing';
  const apiKeyMode = detectAuthMode() === 'api-key';
  const oauthCredFiles = [
    process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json')
      : '',
    path.join(homeDir, '.claude', '.credentials.json'),
  ].filter(Boolean);
  for (const credFile of oauthCredFiles) {
    if (!fs.existsSync(credFile)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
      const token = parsed?.claudeAiOauth?.accessToken;
      if (typeof token === 'string' && token.trim()) {
        credentials = 'configured';
        break;
      }
    } catch {
      // unreadable / malformed JSON — treat as missing for this source
    }
  }
  if (apiKeyMode && credentials !== 'configured') {
    logger.warn(
      { checkedOauthSources: oauthCredFiles },
      'ANTHROPIC_API_KEY detected (proxy/container path would run in ' +
        'api-key mode) but no Claude OAuth credential found. The host ' +
        'quality-check gate is subscription-OAuth-only (2026-07-11 ' +
        'cutover) and would return token_missing on every check — ' +
        'credentials remain "missing" fail-closed. Provide the OAuth ' +
        'credential file, or accept a dark quality gate knowingly.',
    );
  }

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'MICROSOFT_APP_ID',
    'MICROSOFT_APP_PASSWORD',
    'TEAMS_BOT_TENANT_ID',
    'ATLAS_OWNER_AAD_OBJECT_ID',
    'ATLAS_OWNER_UPN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
  ]);

  const channelAuth: Record<string, string> = {};

  // WhatsApp: check for auth credentials on disk
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  // Token-based channels: check .env
  // Teams is the primary CEO command channel. The single-tenant bot needs all
  // three of app id / password / tenant id (registerChannel returns null if any
  // is missing — see src/channels/teams.ts). It ALSO needs at least one owner
  // identifier (aadObjectId or UPN): without one the owner gate fails closed and
  // refuses EVERY sender (src/secondbrain/owner.ts), so the CEO could not use
  // typed commands or card taps even with valid bot creds. Require both halves
  // before reporting Teams as configured — otherwise verify would green-light a
  // bot that answers no one.
  // Trim every candidate the same way the runtime owner gate does
  // (loadOwnerConfigFromEnv in src/secondbrain/owner.ts drops whitespace-only
  // values), so a value like "   " is not counted as configured here while the
  // runtime refuses every sender.
  const firstNonBlank = (...vals: Array<string | undefined>): string =>
    vals.map((v) => (v ?? '').trim()).find((v) => v !== '') ?? '';
  const teamsBotCreds =
    firstNonBlank(process.env.MICROSOFT_APP_ID, envVars.MICROSOFT_APP_ID) &&
    firstNonBlank(
      process.env.MICROSOFT_APP_PASSWORD,
      envVars.MICROSOFT_APP_PASSWORD,
    ) &&
    firstNonBlank(process.env.TEAMS_BOT_TENANT_ID, envVars.TEAMS_BOT_TENANT_ID);
  const teamsOwnerIdentity = firstNonBlank(
    process.env.ATLAS_OWNER_AAD_OBJECT_ID,
    envVars.ATLAS_OWNER_AAD_OBJECT_ID,
    process.env.ATLAS_OWNER_UPN,
    envVars.ATLAS_OWNER_UPN,
  );
  if (teamsBotCreds && teamsOwnerIdentity) {
    channelAuth.teams = 'configured';
  }
  if (
    (process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN) &&
    (process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN)
  ) {
    channelAuth.slack = 'configured';
  }
  if (process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  // Reported for diagnostics; the success verdict requires the TEAMS gate
  // specifically (computeVerifyStatus), not just any configured channel.
  const configuredChannels = Object.keys(channelAuth);

  // 5. Check registered groups (using better-sqlite3, not sqlite3 CLI)
  let registeredGroups = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // Determine overall status
  const status = computeVerifyStatus({
    service,
    credentials,
    channelAuth,
    registeredGroups,
  });

  if (status === 'failed' && !teamsGateSatisfied(channelAuth)) {
    logger.error(
      { channelAuth },
      'Teams gate failed: Teams is the primary CEO command channel and must ' +
        'be configured (bot creds + owner identity) before verify can report ' +
        'success — see teams/PROVISIONING.md and .env.example',
    );
  }

  logger.info({ status, channelAuth }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
