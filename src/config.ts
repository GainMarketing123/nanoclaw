import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
// HOME_DIR: explicit home for the atlas user.
// On Linux: env var takes precedence so services running as a different OS user
// (e.g. nanoclaw-svc) still resolve to the correct atlas home where .claude/
// and .atlas/ live. On Windows: always use os.homedir() because $HOME can be
// an MSYS-style path (/c/Users/...) that breaks path.join.
export const HOME_DIR =
  process.platform !== 'win32' && process.env.HOME
    ? process.env.HOME
    : os.homedir();

// CLAUDE_CONFIG_DIR is the Claude CLI / Anthropic SDK standard env var
// for relocating the Claude config + credentials root. When the runtime
// user is not the credential owner (Phase 3.2 nanoclaw-he case), the env
// override points the proxy + container-runner at the actual location
// (e.g. /home/nanoclaw-he/.claude). HOST_CLAUDE_DIR is retained as a
// back-compat alias for existing imports — callers should migrate to
// CLAUDE_CONFIG_DIR over time.
export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude');
export const HOST_CLAUDE_DIR = CLAUDE_CONFIG_DIR;

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a positive-integer env value, falling back to `fallback` when the value
 * is unset, non-numeric, or not a positive integer. Plain parseInt would let a
 * typo'd env value flow through as NaN; for the health thresholds that turns the
 * liveness comparisons (sinceLastBeatMs > stallThresholdMs) into `> NaN`, which
 * is always false, so /health would never report a stall. Guard at the source.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Atlas governance state directory (host-level, not mounted into containers)
// Containers see this at /workspace/extra/atlas-state via mounts
// ATLAS_DIR env-var override mirrors the Python host-executor pattern (same
// audit doc 1.A.6 condition (b) decoupling): explicit path config so a future
// user-account migration can repoint both services without simultaneous code +
// deploy changes. Defaults to the historical home-relative location.
//
// ATLAS_DIR is the canonical name (matches Python lib/atlas_paths.py and the
// engineering-side env-var contract). ATLAS_STATE_DIR is retained as a
// back-compat alias for existing imports — callers should migrate to
// ATLAS_DIR over time.
export const ATLAS_DIR = process.env.ATLAS_DIR || path.join(HOME_DIR, '.atlas');
export const ATLAS_STATE_DIR = ATLAS_DIR;

// Atlas Operations directory — bridge, swarm, entities, security
// Post three-repo split: operations state lives separately from engineering
export const ATLAS_OPS_DIR =
  process.env.ATLAS_OPS_DIR || path.join(HOME_DIR, '.atlas-operations');

// Bridge callback port — bridge_server.py listens here for mission callbacks
export const BRIDGE_CALLBACK_PORT = parseInt(
  process.env.BRIDGE_CALLBACK_PORT || '3002',
  10,
);

// Health endpoint port — the orchestrator serves GET /health here so the
// atlas-watchdog can detect an internally-wedged process (the message loop
// stalled) that a bare `pgrep` still sees as "alive". Loopback-only.
//
// Port map (VPS host): 3001 = credential proxy, 3002 = atlas-bridge callback,
// 3003 = host-executor quality-check server (host/host-executor.py
// QUALITY_CHECK_PORT — a POST-only Python handler that answers GET with 501).
// The default here MUST NOT be 3003: the original 3003 default collided with
// that server, so the orchestrator's health bind failed (best-effort: logged
// and continued) and the watchdog's GET /health probe reached the
// quality-check handler instead — the live "501 wrong-service-on-port"
// finding from the 2026-06-11 trace. src/config.test.ts pins the defaults
// pairwise-distinct so the collision cannot silently come back.
export const HEALTH_PORT = parsePositiveInt(process.env.HEALTH_PORT, 3004);

// How stale the message-loop heartbeat may get before /health reports 503.
// Must sit comfortably above POLL_INTERVAL (2s) plus any in-loop await so a
// normal busy iteration never trips it; 60s flags a genuine wedge fast enough
// for the watchdog without false positives under load.
export const HEALTH_STALL_THRESHOLD_MS = parsePositiveInt(
  process.env.HEALTH_STALL_THRESHOLD_MS,
  60000,
);

// How long the process may sit pre-first-heartbeat (still booting) before
// /health reports unhealthy. The health server starts BEFORE channel.connect()
// and startMessageLoop(), so without a bound a startup wedge (e.g. a hung
// channel connect) would keep /health returning 200 forever — defeating the
// watchdog for the exact internal-stall class it exists to catch. Generous
// enough to cover a normal cold start (channel auth + DB open) without
// false-tripping; once exceeded, /health returns 503 until the loop beats.
export const HEALTH_STARTUP_GRACE_MS = parsePositiveInt(
  process.env.HEALTH_STARTUP_GRACE_MS,
  120000,
);
