/**
 * HTTP /health endpoint for the orchestrator.
 *
 * Bound to loopback only (same posture as the credential proxy). Exists so the
 * atlas-watchdog can probe internal liveness instead of only `pgrep`-ing the
 * process: a wedged message loop leaves the process alive but stops all work,
 * which a bare process check cannot detect.
 *
 * Contract (matches Paperclip's /health convention the watchdog already uses):
 *   GET /health  ->  200 {"status":"ok", ...}        when the work loop is live
 *                ->  503 {"status":"unhealthy", ...}  when the loop is wedged
 *   any other route -> 404
 *
 * The handler is intentionally synchronous and does NOT touch the DB, the
 * network, or any lock — it only reads an in-memory heartbeat. This guarantees
 * the probe itself returns in single-digit milliseconds and can never hang
 * (the failure mode that caused Paperclip's /api/health to wedge the watchdog
 * — see atlas-operations docs/research/paperclip-pgpool-wedge.md). The
 * heartbeat is updated by the message loop, so a stalled loop is reflected as
 * a stale heartbeat here without this endpoint having to block on anything.
 */
import { createServer, Server } from 'http';

import { getHealthSnapshot } from './health.js';
import { logger } from './logger.js';

export function startHealthServer(
  port: number,
  stallThresholdMs: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Only GET /health (and HEAD, for cheap probes) is served.
      const url = (req.url || '').split('?')[0];
      if (url !== '/health' && url !== '/healthz') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_found' }));
        return;
      }

      const snapshot = getHealthSnapshot(stallThresholdMs);
      const statusCode = snapshot.healthy ? 200 : 503;
      const payload = {
        status: snapshot.healthy ? 'ok' : 'unhealthy',
        ...snapshot,
      };

      if (!snapshot.healthy) {
        logger.warn({ snapshot }, 'Health probe reported unhealthy');
      }

      res.writeHead(statusCode, { 'content-type': 'application/json' });
      // HEAD must not include a body, but the status code already carries the
      // verdict — the watchdog keys off the HTTP code, not the body.
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    });

    server.listen(port, host, () => {
      logger.info({ port, host, stallThresholdMs }, 'Health server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
