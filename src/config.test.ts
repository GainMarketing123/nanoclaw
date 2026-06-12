import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loopback port-map collision regression tests.
 *
 * The VPS host runs several loopback HTTP listeners side by side:
 *   3001 — credential proxy (this repo, CREDENTIAL_PROXY_PORT)
 *   3002 — atlas-bridge callback (BRIDGE_CALLBACK_PORT)
 *   3003 — host-executor quality-check server (host/host-executor.py
 *          QUALITY_CHECK_PORT, hardcoded — a POST-only Python handler that
 *          answers GET with 501)
 *   3004 — orchestrator /health endpoint (HEALTH_PORT)
 *
 * HEALTH_PORT originally defaulted to 3003, colliding with the quality-check
 * server: the orchestrator's bind failed best-effort (logged and continued)
 * and the watchdog's GET /health probe reached the quality-check handler,
 * which returned the live "501 wrong-service-on-port" seen in the 2026-06-11
 * trace. These tests pin the DEFAULTS (env overrides cleared) so the
 * collision cannot silently come back.
 */

// host/host-executor.py QUALITY_CHECK_PORT — hardcoded on the Python side and
// in container/agent-runner/src/governance/response-interceptor.ts. No env
// propagation channel exists for it, so mirror the constant here.
const QUALITY_CHECK_PORT = 3003;

const PORT_ENV_VARS = [
  'CREDENTIAL_PROXY_PORT',
  'BRIDGE_CALLBACK_PORT',
  'HEALTH_PORT',
];

async function importConfigWithDefaultPorts() {
  vi.resetModules();
  for (const name of PORT_ENV_VARS) {
    vi.stubEnv(name, '');
    delete process.env[name];
  }
  return import('./config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('loopback port map defaults', () => {
  it('HEALTH_PORT default does not collide with the host-executor quality-check server (3003)', async () => {
    const config = await importConfigWithDefaultPorts();
    expect(config.HEALTH_PORT).not.toBe(QUALITY_CHECK_PORT);
  });

  it('all loopback service ports are pairwise distinct by default', async () => {
    const config = await importConfigWithDefaultPorts();
    const ports = [
      config.CREDENTIAL_PROXY_PORT,
      config.BRIDGE_CALLBACK_PORT,
      config.HEALTH_PORT,
      QUALITY_CHECK_PORT,
    ];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('HEALTH_PORT env override still wins over the default', async () => {
    vi.resetModules();
    vi.stubEnv('HEALTH_PORT', '3999');
    const config = await import('./config.js');
    expect(config.HEALTH_PORT).toBe(3999);
  });
});
