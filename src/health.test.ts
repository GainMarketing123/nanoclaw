import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetHealthState,
  getHealthSnapshot,
  recordLoopBeat,
} from './health.js';
import { startHealthServer } from './health-server.js';

describe('health snapshot', () => {
  beforeEach(() => {
    _resetHealthState();
  });

  it('reports healthy while the loop has not started yet (booting)', () => {
    const snap = getHealthSnapshot(60_000);
    expect(snap.healthy).toBe(true);
    expect(snap.loopStarted).toBe(false);
    expect(snap.reason).toBeUndefined();
  });

  it('reports healthy when the loop beat within the stall threshold', () => {
    const now = 1_000_000;
    recordLoopBeat(now);
    const snap = getHealthSnapshot(60_000, now + 5_000);
    expect(snap.healthy).toBe(true);
    expect(snap.loopStarted).toBe(true);
    expect(snap.sinceLastBeatMs).toBe(5_000);
    expect(snap.loopIterations).toBe(1);
  });

  it('reports unhealthy when the heartbeat is older than the threshold', () => {
    const now = 1_000_000;
    recordLoopBeat(now);
    const snap = getHealthSnapshot(60_000, now + 60_001);
    expect(snap.healthy).toBe(false);
    expect(snap.reason).toMatch(/stalled/);
    expect(snap.sinceLastBeatMs).toBe(60_001);
  });

  it('recovers to healthy once a fresh beat lands after a stall', () => {
    const start = 2_000_000;
    recordLoopBeat(start);
    expect(getHealthSnapshot(60_000, start + 120_000).healthy).toBe(false);
    recordLoopBeat(start + 120_000);
    expect(getHealthSnapshot(60_000, start + 121_000).healthy).toBe(true);
  });

  it('counts iterations', () => {
    recordLoopBeat(1);
    recordLoopBeat(2);
    recordLoopBeat(3);
    expect(getHealthSnapshot(60_000, 3).loopIterations).toBe(3);
  });
});

describe('health HTTP endpoint', () => {
  let server: Awaited<ReturnType<typeof startHealthServer>>;
  let baseUrl: string;
  const STALL_MS = 60_000;

  beforeEach(async () => {
    _resetHealthState();
    // port 0 => ephemeral free port, avoids clashing with a running orchestrator
    server = await startHealthServer(0, STALL_MS);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.close();
  });

  it('returns 200 + status ok when the loop is beating', async () => {
    recordLoopBeat();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.healthy).toBe(true);
    expect(body.loopStarted).toBe(true);
  });

  it('returns 200 while booting (loop not started)', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.loopStarted).toBe(false);
  });

  it('also serves /healthz (watchdog alias)', async () => {
    recordLoopBeat();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('responds fast and does not block (no DB / network in handler)', async () => {
    recordLoopBeat();
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    // generous ceiling — the point is it never hangs like a DB-probing endpoint
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
