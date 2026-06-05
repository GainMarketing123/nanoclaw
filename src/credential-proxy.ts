/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Auto-refresh (OAuth mode):
 *   Reads access + refresh tokens from ~/.claude/.credentials.json.
 *   When upstream returns 401, automatically refreshes using the refresh
 *   token (standard OAuth2 flow), updates the credentials file, and
 *   retries the request. Only alerts CEO if the refresh token itself fails.
 *   Access token expiration never causes downtime.
 *
 * INTENTIONAL ANTHROPIC_API_KEY USAGE — do NOT include in env-strip sweeps.
 * ------------------------------------------------------------------------
 * Cost-burn audit 2026-05-12 (the $76 XgAA-key leak) introduced an
 * `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env-strip pattern that gets
 * applied to every site that spawns `claude -p` so the CLI falls through
 * to OAuth Max subscription instead of silently billing the metered key.
 * THAT PATTERN DOES NOT APPLY HERE. This file is an HTTP proxy: it loads
 * ANTHROPIC_API_KEY via loadAnthropicApiKey() (systemd LoadCredential →
 * env → ATLAS_DIR/.env, mirroring host-executor) and either injects it
 * as an x-api-key header on api-key deployments, or runs in OAuth mode
 * and never touches the key. There is no child_process spawn, no
 * `claude -p`, and nothing for an env strip to act on. Removing the key
 * here would silently break api-key-mode deployments (containers would
 * see "missing x-api-key" on every upstream call).
 *
 * Future env-strip sweeps: this file is OUT OF SCOPE. Leave the key
 * loading path in place.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';

import { ATLAS_DIR, HOST_CLAUDE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// Credentials file path (where Claude Code stores OAuth tokens).
// Uses HOST_CLAUDE_DIR (= CLAUDE_CONFIG_DIR env or ~/home/.claude) so services
// running as non-atlas users still find the right file.
// NOTE: when CLAUDE_CONFIG_DIR is set in the shared /etc/atlas/atlas.env for the
// Phase 3.2 nanoclaw-he migration, ALL services that source that file inherit the
// value — including the nanoclaw orchestrator which may run as a different user.
// loadCredentials() handles the resulting EACCES by trying the process-effective
// home .credentials.json as a fallback before giving up.
const CREDENTIALS_PATH = path.join(HOST_CLAUDE_DIR, '.credentials.json');
// Process-effective home fallback: used by loadCredentials() when CREDENTIALS_PATH
// is not readable due to EACCES (shared-env CLAUDE_CONFIG_DIR pointing at another
// user's .claude directory). Computed once so both load and save use the same path.
const CREDENTIALS_PATH_FALLBACK = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

// Anthropic OAuth endpoints
const OAUTH_BASE = 'https://claude.ai';
const TOKEN_ENDPOINT = '/api/oauth/token';

// Rate-limit refresh attempts to prevent loops
let lastRefreshAttempt = 0;
const REFRESH_COOLDOWN_MS = 30_000; // 30 seconds between attempts

// Outage tracking — self-healing when Anthropic API goes down and comes back
let isInOutage = false;
let outageAlertSent = false;
let outageStartedAt = 0;
let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_CHECK_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]; // 30s → 1m → 2m → 5m cap
const OUTAGE_STATUS_CODES = new Set([500, 502, 503, 529]); // Anthropic outage indicators

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

// Tracks which credentials file reads actually succeeded from, so token-refresh
// writes (saveCredentials) persist to the SAME file rather than always the
// configured primary. Without this, an EACCES-on-primary deployment reads via
// the fallback but writes still throw on the inaccessible primary, so refreshed
// tokens never persist durably. Defaults to the primary until a read proves otherwise.
let activeCredentialsPath = CREDENTIALS_PATH;

/**
 * Read the raw OAuthCredentials record from disk, trying CREDENTIALS_PATH
 * first and CREDENTIALS_PATH_FALLBACK on EACCES.
 * Returns null when neither path has a usable record.
 */
function readRawOauthRecord(): OAuthCredentials | null {
  const pathsToTry =
    CREDENTIALS_PATH_FALLBACK !== CREDENTIALS_PATH
      ? [CREDENTIALS_PATH, CREDENTIALS_PATH_FALLBACK]
      : [CREDENTIALS_PATH];

  for (const credPath of pathsToTry) {
    try {
      if (!fs.existsSync(credPath)) continue;
      const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      const oauth: OAuthCredentials = data.claudeAiOauth;
      if (oauth?.accessToken) {
        activeCredentialsPath = credPath;
        return oauth;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' && credPath === CREDENTIALS_PATH) {
        logger.warn(
          { configured: credPath, fallback: CREDENTIALS_PATH_FALLBACK },
          'EACCES reading credentials.json — trying process-home fallback',
        );
        continue;
      }
      // Other read/parse errors: skip silently (non-fatal caller handles it)
    }
  }
  return null;
}

/**
 * Read OAuth credentials from ~/.claude/.credentials.json.
 * Falls back to .env CLAUDE_CODE_OAUTH_TOKEN if file doesn't exist.
 *
 * EACCES handling: if CLAUDE_CONFIG_DIR in the shared atlas.env points at
 * nanoclaw-he's .claude dir but this process runs as a different user, the
 * primary path throws EACCES. readRawOauthRecord() falls through to the
 * process-effective home path before giving up. Root fix: scope
 * CLAUDE_CONFIG_DIR to the host-executor service unit only.
 */
function loadCredentials(envFallback?: string): {
  accessToken: string;
  refreshToken: string | null;
} {
  const oauth = readRawOauthRecord();
  if (oauth) {
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || null,
    };
  }
  // Fallback to .env token (no refresh capability)
  return {
    accessToken: envFallback || '',
    refreshToken: null,
  };
}

/**
 * Save refreshed credentials back to ~/.claude/.credentials.json.
 */
function saveCredentials(
  newAccessToken: string,
  newRefreshToken: string,
  expiresIn: number,
): void {
  try {
    // Persist to the path reads actually succeeded from (mirrors
    // readRawOauthRecord's primary-then-fallback), so an EACCES-on-primary
    // deployment refreshes tokens durably instead of throwing on every write.
    const credPath = activeCredentialsPath;
    let data: Record<string, unknown> = {};
    if (fs.existsSync(credPath)) {
      data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    }

    const existing = (data.claudeAiOauth || {}) as Record<string, unknown>;
    data.claudeAiOauth = {
      ...existing,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    const dir = path.dirname(credPath);
    fs.mkdirSync(dir, { recursive: true });

    // Codex cfc93bb F1 BLOCKING fix: atomic write via temp-file-in-directory
    // + rename. Prior writeFileSync truncated the live file in place — a
    // concurrent loadCredentials() (5-min refresh loop, host script,
    // re-load on auth-error) could parse half-written JSON and fall back
    // to .env. fs.renameSync on the same filesystem is atomic at the
    // rename boundary, so readers see either the old file or the new
    // file, never a mid-write state. Same pattern as the shell-side fix
    // in host/refresh-claude-auth.sh.
    //
    // Codex 64a06c7 F1 BLOCKING fix: preserve uid/gid on the rename. The
    // proxy may run under a different user than the one that owns the
    // existing credentials file (host/refresh-claude-auth.sh writes as
    // nanoclaw-he). renameSync swaps the temp file's inode in, so without
    // explicit chown the new file inherits the proxy process's uid — the
    // next claude auth status under nanoclaw-he gets EPERM. Read existing
    // owner first, then chown temp to match before rename.
    const tmpPath = `${credPath}.new.${process.pid}.${Date.now()}`;
    let targetUid: number | null = null;
    let targetGid: number | null = null;
    try {
      const existingStat = fs.statSync(credPath);
      targetUid = existingStat.uid;
      targetGid = existingStat.gid;
    } catch {
      // File doesn't exist yet — first-time write. uid/gid unset; the
      // rename will adopt the proxy process's defaults, which is correct
      // when there's no prior owner contract to preserve.
    }
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      if (targetUid !== null && targetGid !== null) {
        try {
          fs.chownSync(tmpPath, targetUid, targetGid);
        } catch (chownErr) {
          // chown may fail if the proxy lacks privilege to set ownership
          // to a foreign user — surface but don't abort, since the rename
          // would still produce a usable file under the proxy's own user
          // when both writer and runtime are the same.
          logger.warn(
            { err: chownErr, targetUid, targetGid },
            'chown failed before atomic rename; preserving proxy-user ownership',
          );
        }
      }
      fs.renameSync(tmpPath, credPath);
    } catch (writeErr) {
      // Clean up the temp file if rename failed.
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup; ignore if temp doesn't exist.
      }
      throw writeErr;
    }

    logger.info('OAuth credentials refreshed and saved (atomic)');
  } catch (err) {
    // Codex 64a06c7 F2 BLOCKING fix: rethrow instead of swallowing.
    // Callers (refreshOauthToken, the 5-min refresh loop) update
    // currentCreds in-memory immediately after this returns. If we
    // swallow, in-memory state advances but on-disk stays stale —
    // proxy appears healthy until restart, then reloads the old token
    // and falls into 401/refresh loops. Surface the error so callers
    // can treat it as a real auth/storage failure (skip in-memory
    // advance, schedule retry, or fail-fast the request).
    logger.error({ err }, 'Failed to save refreshed credentials (atomic)');
    throw err;
  }
}

/**
 * Typed refresh result — distinguishes network errors (outage) from token errors (real auth issue).
 */
type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresIn: number }
  | { ok: false; reason: 'network_error' | 'token_invalid' | 'server_error' };

/**
 * Use the refresh token to obtain a new access token.
 * Standard OAuth2 refresh_token grant.
 * Returns typed result so callers can distinguish outage from real auth failure.
 */
function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', // Claude Code public client ID
    });

    const req = httpsRequest(
      {
        hostname: 'claude.ai',
        port: 443,
        path: TOKEN_ENDPOINT,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 15_000, // 15s timeout to detect unreachable API quickly
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode === 200 && body.access_token) {
              resolve({
                ok: true,
                accessToken: body.access_token,
                refreshToken: body.refresh_token || refreshToken,
                expiresIn: body.expires_in || 3600,
              });
            } else if (OUTAGE_STATUS_CODES.has(res.statusCode!)) {
              // Server error = outage, not a token problem
              logger.warn(
                { statusCode: res.statusCode },
                'OAuth refresh got server error — likely outage',
              );
              resolve({ ok: false, reason: 'server_error' });
            } else {
              // 400/401/403 = token itself is bad
              logger.error(
                { statusCode: res.statusCode, error: body.error },
                'OAuth refresh failed — token may be invalid',
              );
              resolve({ ok: false, reason: 'token_invalid' });
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse refresh response');
            resolve({ ok: false, reason: 'server_error' });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      logger.warn('OAuth refresh request timed out — API unreachable');
      resolve({ ok: false, reason: 'network_error' });
    });

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth refresh request error — network issue');
      resolve({ ok: false, reason: 'network_error' });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Enter outage mode and start background health-check recovery loop.
 * Polls with exponential backoff. When API comes back, refreshes tokens
 * and resumes service automatically — no CEO intervention needed.
 */
function startOutageRecovery(creds: {
  accessToken: string;
  refreshToken: string | null;
}): void {
  if (healthCheckTimer) return; // already recovering

  if (!isInOutage) {
    isInOutage = true;
    outageStartedAt = Date.now();
  }

  // Alert CEO once, not every 30 seconds
  if (!outageAlertSent) {
    outageAlertSent = true;
    sendAlert(
      '*Anthropic API Outage Detected*\n\n' +
        'Atlas credential proxy cannot reach the API. ' +
        'Auto-recovery is active — will restore service automatically when the outage ends.\n\n' +
        'No action needed unless this persists for hours.',
    );
  }

  let attempt = 0;

  const tryRecover = async (): Promise<void> => {
    if (!creds.refreshToken) {
      logger.error('No refresh token available for outage recovery');
      // Codex b48776f F2 BLOCKING fix: clear healthCheckTimer so a later
      // request that updates currentCreds (e.g., file-reload in the proactive
      // path) and triggers startOutageRecovery again can actually start a
      // fresh recovery cycle. Without this, healthCheckTimer holds a stale
      // ID and the `if (healthCheckTimer) return` global lock at
      // startOutageRecovery permanently blocks re-entry.
      healthCheckTimer = null;
      return;
    }

    const result = await refreshAccessToken(creds.refreshToken);

    if (result.ok) {
      // API is back — save tokens, restore service.
      // Codex 64a06c7 F2 BLOCKING fix: persistence-or-bust on outage
      // recovery. If save fails, stay in outage mode so the next health
      // check retries the persistence step rather than declaring recovery
      // with stale on-disk credentials.
      try {
        saveCredentials(
          result.accessToken,
          result.refreshToken,
          result.expiresIn,
        );
        creds.accessToken = result.accessToken;
        creds.refreshToken = result.refreshToken;
      } catch (saveErr) {
        // Codex b48776f F2 BLOCKING fix: schedule the next retry
        // explicitly. The one-shot setTimeout that fired this tryRecover
        // is consumed; without rescheduling here, healthCheckTimer holds
        // a stale ID and the global re-entry lock at startOutageRecovery
        // permanently blocks future recovery attempts.
        const delay =
          HEALTH_CHECK_BACKOFF_MS[
            Math.min(attempt, HEALTH_CHECK_BACKOFF_MS.length - 1)
          ];
        attempt++;
        logger.error(
          { err: saveErr, attempt, nextCheckSec: Math.round(delay / 1000) },
          'Outage recovery refresh succeeded but persistence failed — rescheduling retry',
        );
        healthCheckTimer = setTimeout(tryRecover, delay);
        return;
      }

      isInOutage = false;
      outageAlertSent = false;
      healthCheckTimer = null;

      const downtimeMin = Math.round((Date.now() - outageStartedAt) / 60_000);
      logger.info(
        { downtimeMinutes: downtimeMin },
        'Outage resolved — auto-recovered',
      );
      sendAlert(
        '*API Recovered*\n\n' +
          `Atlas auto-recovered after ~${downtimeMin} minute(s). ` +
          'Tokens refreshed, service fully restored.',
      );
    } else if (!result.ok) {
      // Still down — schedule next check with backoff
      const delay =
        HEALTH_CHECK_BACKOFF_MS[
          Math.min(attempt, HEALTH_CHECK_BACKOFF_MS.length - 1)
        ];
      attempt++;
      logger.info(
        {
          attempt,
          nextCheckSec: Math.round(delay / 1000),
          reason: result.reason,
        },
        'Outage persists — scheduling next health check',
      );
      healthCheckTimer = setTimeout(tryRecover, delay);
    }
  };

  // First check after 30 seconds
  healthCheckTimer = setTimeout(tryRecover, HEALTH_CHECK_BACKOFF_MS[0]);
}

/**
 * Send an alert to the CEO via NanoClaw IPC (best effort). Channel-agnostic:
 * delivers to the registered main group JID, now a Teams chat.
 */
function sendAlert(message: string): void {
  try {
    const ipcDir = path.join(
      process.cwd(),
      'data',
      'ipc',
      'atlas_main',
      'messages',
    );
    fs.mkdirSync(ipcDir, { recursive: true });

    // Read main group JID
    const Database = require('better-sqlite3');
    const dbPath = path.join(process.cwd(), 'store', 'messages.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1')
      .get() as { jid: string } | undefined;
    db.close();

    if (!row) return;

    const alertFile = path.join(ipcDir, `auth-alert-${Date.now()}.json`);
    fs.writeFileSync(
      alertFile,
      JSON.stringify({
        type: 'message',
        chatJid: row.jid,
        text: message,
      }),
    );
  } catch {
    // Best effort — don't crash the proxy over an alert
  }
}

/**
 * Forward a request to upstream, collecting the full response.
 */
function forwardRequest(
  makeReq: typeof httpsRequest,
  options: RequestOptions,
  body: Buffer,
): Promise<{
  statusCode: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const upstream = makeReq(options, (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        resolve({
          statusCode: upRes.statusCode!,
          headers: upRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    upstream.on('error', reject);
    upstream.write(body);
    upstream.end();
  });
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Codex 8ac9c6c F1 BLOCKING fix: read ATLAS_DIR/.env explicitly (NOT the
  // project-root default that env.ts reverted to). Atlas-host secrets
  // (OAUTH_TOKEN, AUTH_TOKEN, ANTHROPIC_BASE_URL) live in the Atlas-shared
  // .env at ATLAS_DIR; project-config secrets (channel tokens, ASSISTANT_NAME)
  // live in nanoclaw's own .env at projectRoot. These are intentionally
  // separate files — pass the explicit dir to disambiguate.
  const secrets = readEnvFile(
    ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
    ATLAS_DIR,
  );

  // ANTHROPIC_API_KEY uses the systemd → env → file precedence; .env-only
  // detection mis-classifies post-Phase-3.1 deployments (where the key only
  // exists at $CREDENTIALS_DIRECTORY/anthropic-api-key).
  const apiKey = loadAnthropicApiKey();
  const authMode: AuthMode = apiKey ? 'api-key' : 'oauth';
  const envOauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // Mutable token state — updated on refresh
  let currentCreds = loadCredentials(envOauthToken);

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Proactive refresh: check token expiry every 5 minutes
  if (authMode === 'oauth') {
    setInterval(() => {
      try {
        // Use readRawOauthRecord() so EACCES on CREDENTIALS_PATH falls back
        // to the process-home path instead of silently skipping the refresh.
        const oauth = readRawOauthRecord();
        if (!oauth?.expiresAt || !oauth?.refreshToken) return;

        const timeToExpiry = oauth.expiresAt - Date.now();
        // Refresh when expired OR expiring within 10 minutes
        // The <= 0 case is critical: after an outage, the token may have
        // expired while API was unreachable. This ensures recovery.
        if (timeToExpiry < 600_000) {
          const label =
            timeToExpiry <= 0
              ? `expired ${Math.round(-timeToExpiry / 60000)}m ago`
              : `expiring in ${Math.round(timeToExpiry / 60000)}m`;
          logger.info({ label }, 'Proactively refreshing token');

          refreshAccessToken(oauth.refreshToken).then((result) => {
            if (result.ok) {
              // Codex 64a06c7 F2 BLOCKING fix: only advance in-memory
              // currentCreds AFTER successful persistence. If saveCredentials
              // throws (chown failed, ENOSPC, etc.), keep the old in-memory
              // state so the proxy doesn't drift from disk — next refresh
              // attempt will retry persistence.
              try {
                saveCredentials(
                  result.accessToken,
                  result.refreshToken,
                  result.expiresIn,
                );
                currentCreds = {
                  accessToken: result.accessToken,
                  refreshToken: result.refreshToken,
                };
              } catch (saveErr) {
                logger.error(
                  { err: saveErr },
                  'Token refreshed but persistence failed; keeping old in-memory state',
                );
                // Don't enter outage mode (refresh worked); the next
                // proactive cycle will retry persistence.
                return;
              }
              // If we were in outage mode, clear it — we just recovered
              if (isInOutage) {
                const downtimeMin = Math.round(
                  (Date.now() - outageStartedAt) / 60_000,
                );
                isInOutage = false;
                outageAlertSent = false;
                if (healthCheckTimer) {
                  clearTimeout(healthCheckTimer);
                  healthCheckTimer = null;
                }
                sendAlert(
                  '*API Recovered*\n\n' +
                    `Atlas auto-recovered after ~${downtimeMin} minute(s). ` +
                    'Tokens refreshed via proactive check.',
                );
              }
              logger.info('Proactive token refresh succeeded');
            } else if (
              !result.ok &&
              (result.reason === 'network_error' ||
                result.reason === 'server_error')
            ) {
              // API is down — enter outage recovery mode
              startOutageRecovery(currentCreds);
            }
            // token_invalid: proactive refresh can't fix a bad token, skip
          });
        }

        // Also reload from file if it was updated externally (e.g., manual scp)
        if (oauth.accessToken !== currentCreds.accessToken) {
          currentCreds = {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
          };
          logger.info(
            'Credentials reloaded from file (external update detected)',
          );
        }
      } catch {
        /* non-fatal */
      }
    }, 300_000); // Every 5 minutes
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        function buildHeaders(): Record<
          string,
          string | number | string[] | undefined
        > {
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            delete headers['x-api-key'];
            headers['x-api-key'] = apiKey;
          } else {
            if (headers['authorization']) {
              delete headers['authorization'];
              if (currentCreds.accessToken) {
                headers['authorization'] = `Bearer ${currentCreds.accessToken}`;
              }
            }
          }
          return headers;
        }

        const options: RequestOptions = {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: req.url,
          method: req.method,
        };

        try {
          let upstreamRes = await forwardRequest(
            makeRequest,
            { ...options, headers: buildHeaders() },
            body,
          );

          // Auto-refresh on 401 in OAuth mode
          if (
            upstreamRes.statusCode === 401 &&
            authMode === 'oauth' &&
            currentCreds.refreshToken &&
            Date.now() - lastRefreshAttempt > REFRESH_COOLDOWN_MS
          ) {
            lastRefreshAttempt = Date.now();
            logger.info(
              'Got 401 from upstream — attempting OAuth token refresh',
            );

            const refreshResult = await refreshAccessToken(
              currentCreds.refreshToken,
            );

            if (refreshResult.ok) {
              // Codex 64a06c7 F2 BLOCKING fix: only advance currentCreds
              // after successful persistence. If save fails, surface a 503
              // to the upstream caller so the request retries with the
              // (still-valid in-memory) old token rather than drifting
              // from disk silently.
              try {
                saveCredentials(
                  refreshResult.accessToken,
                  refreshResult.refreshToken,
                  refreshResult.expiresIn,
                );
                currentCreds = {
                  accessToken: refreshResult.accessToken,
                  refreshToken: refreshResult.refreshToken,
                };
              } catch (saveErr) {
                logger.error(
                  { err: saveErr },
                  'OAuth refresh succeeded on 401 but persistence failed — surfacing 503 so caller retries',
                );
                if (!res.headersSent) {
                  res.writeHead(503, { 'Content-Type': 'application/json' });
                  res.end(
                    JSON.stringify({
                      error: 'credential persistence failed during refresh',
                    }),
                  );
                }
                return;
              }
              // Clear outage state if we were in one
              if (isInOutage) {
                isInOutage = false;
                outageAlertSent = false;
                if (healthCheckTimer) {
                  clearTimeout(healthCheckTimer);
                  healthCheckTimer = null;
                }
              }
              logger.info('Token refreshed successfully, retrying request');

              // Retry with new token
              upstreamRes = await forwardRequest(
                makeRequest,
                { ...options, headers: buildHeaders() },
                body,
              );
            } else if (
              !refreshResult.ok &&
              (refreshResult.reason === 'network_error' ||
                refreshResult.reason === 'server_error')
            ) {
              // API is down — this is an outage, not a token problem
              // Start background recovery loop instead of alerting for manual intervention
              logger.warn(
                'Cannot refresh token — API unreachable. Entering outage recovery mode.',
              );
              startOutageRecovery(currentCreds);
            } else {
              // token_invalid — refresh token itself is broken, CEO must re-auth
              logger.error(
                'OAuth refresh token is invalid — manual intervention required',
              );
              sendAlert(
                '*OAuth Refresh Token Failed*\n\n' +
                  'The refresh token is invalid or expired. This is NOT an outage — the token needs replacing.\n\n' +
                  'From your laptop, run:\n' +
                  '`scp ~/.claude/.credentials.json root@5.78.190.56:/home/nanoclaw-he/.claude/.credentials.json`\n\n' +
                  'Then: `ssh root@5.78.190.56 systemctl restart nanoclaw`',
              );
            }
          }

          // Detect outage via upstream server errors (even without 401)
          if (
            OUTAGE_STATUS_CODES.has(upstreamRes.statusCode) &&
            !isInOutage &&
            authMode === 'oauth'
          ) {
            logger.warn(
              { statusCode: upstreamRes.statusCode },
              'Upstream returned server error — possible outage',
            );
            startOutageRecovery(currentCreds);
          }

          // Send response to client
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          res.end(upstreamRes.body);
        } catch (err) {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          // Connection failure to upstream = likely outage
          if (!isInOutage && authMode === 'oauth') {
            startOutageRecovery(currentCreds);
          }
          if (!res.headersSent) {
            res.writeHead(isInOutage ? 503 : 502);
            res.end(
              isInOutage
                ? 'Service Temporarily Unavailable — outage recovery in progress'
                : 'Bad Gateway',
            );
          }
        }
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, hasRefreshToken: !!currentCreds.refreshToken },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/**
 * Load ANTHROPIC_API_KEY following the host-executor precedence so the proxy
 * and the host process agree on auth mode regardless of how the secret is
 * delivered. Mirrors host/host-executor.py:_load_anthropic_api_key():
 *   1. $CREDENTIALS_DIRECTORY/anthropic-api-key  (systemd LoadCredential —
 *      Phase 3.1 production cutover; .env may be empty post-cutover)
 *   2. process.env.ANTHROPIC_API_KEY              (pre-3.1 EnvironmentFile +
 *      direct shell-set for dev/test)
 *   3. .env file fallback                         (laptop / partial deploy)
 * Returns the trimmed key or "" if all three paths fail.
 *
 * Without this precedence, post-Phase-3.1 deployments where .env's
 * ANTHROPIC_API_KEY is removed in favor of the systemd credential will be
 * mis-classified as oauth by the proxy/container-runner, causing 401s on
 * upstream requests despite a valid API key being present via systemd.
 */
function loadAnthropicApiKey(): string {
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    try {
      const credPath = path.join(credDir, 'anthropic-api-key');
      if (fs.existsSync(credPath)) {
        const content = fs.readFileSync(credPath, 'utf-8').trim();
        if (content) return content;
      }
    } catch {
      // Transient read failure — fall through to legacy paths.
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  // Codex 8ac9c6c F1 BLOCKING fix: read ATLAS_DIR/.env explicitly. Same
  // rationale as startCredentialProxy() — Atlas-host secrets live in the
  // Atlas-shared .env, not project root.
  const fileSecrets = readEnvFile(['ANTHROPIC_API_KEY'], ATLAS_DIR);
  return fileSecrets.ANTHROPIC_API_KEY || '';
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  return loadAnthropicApiKey() ? 'api-key' : 'oauth';
}
