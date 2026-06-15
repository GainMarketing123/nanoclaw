import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SecondBrainClient } from './client.js';

/**
 * A tiny in-process HTTP server whose response for the next request can be
 * swapped per test. Lets us exercise the real http transport in client.ts
 * without mocking node internals.
 */
let server: http.Server;
let baseUrl: string;
let nextHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => nextHandler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function respondWith(status: number, body: unknown): void {
  nextHandler = (_req, res) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
}

describe('SecondBrainClient.listEntities', () => {
  it('returns the data array from a healthy envelope', async () => {
    respondWith(200, {
      data: [
        { id: 'e-gpg', slug: 'gpg', display_name: 'GPG' },
        { id: 'e-personal', slug: 'personal', display_name: null },
      ],
      degraded: false,
      error: null,
    });

    const client = new SecondBrainClient(baseUrl, { timeoutMs: 2000 });
    const entities = await client.listEntities();

    expect(entities).toEqual([
      { id: 'e-gpg', slug: 'gpg', display_name: 'GPG' },
      { id: 'e-personal', slug: 'personal', display_name: null },
    ]);
  });

  it('returns [] on a degraded envelope', async () => {
    respondWith(200, { data: null, degraded: true, error: null });

    const client = new SecondBrainClient(baseUrl, { timeoutMs: 2000 });
    expect(await client.listEntities()).toEqual([]);
  });

  it('returns [] on a server error / unparseable body', async () => {
    nextHandler = (_req, res) => {
      res.statusCode = 500;
      res.end('not json');
    };

    const client = new SecondBrainClient(baseUrl, { timeoutMs: 2000 });
    expect(await client.listEntities()).toEqual([]);
  });
});

describe('SecondBrainClient access-wall headers', () => {
  // Capture the headers the next request presents, then answer with a healthy
  // empty envelope so the client call resolves cleanly. Header names arrive
  // lowercased by node's http server.
  function captureHeaders(): { current: http.IncomingHttpHeaders | null } {
    const box: { current: http.IncomingHttpHeaders | null } = { current: null };
    nextHandler = (req, res) => {
      box.current = req.headers;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [], degraded: false, error: null }));
    };
    return box;
  }

  it('emits the space token and master secret when both are configured', async () => {
    const box = captureHeaders();
    const client = new SecondBrainClient(baseUrl, {
      timeoutMs: 2000,
      apiKey: 'ingest-key',
      spaceToken: 'space-tok',
      allAccessSecret: 'master-sec',
    });

    await client.listEntities();

    expect(box.current).not.toBeNull();
    expect(box.current!['x-atlas-space-token']).toBe('space-tok');
    expect(box.current!['x-atlas-all-access-secret']).toBe('master-sec');
    // The ingest secret must STILL emit alongside the new headers.
    expect(box.current!['x-atlas-ingest-secret']).toBe('ingest-key');
  });

  it('omits both access-wall headers when neither is configured', async () => {
    const box = captureHeaders();
    const client = new SecondBrainClient(baseUrl, {
      timeoutMs: 2000,
      apiKey: 'ingest-key',
    });

    await client.listEntities();

    expect(box.current).not.toBeNull();
    expect(box.current!['x-atlas-space-token']).toBeUndefined();
    expect(box.current!['x-atlas-all-access-secret']).toBeUndefined();
    // The ingest secret still emits — only the access-wall headers are gated.
    expect(box.current!['x-atlas-ingest-secret']).toBe('ingest-key');
  });

  it('emits only the configured access-wall header, gating each independently', async () => {
    const box = captureHeaders();
    const client = new SecondBrainClient(baseUrl, {
      timeoutMs: 2000,
      spaceToken: 'space-only',
    });

    await client.listEntities();

    expect(box.current).not.toBeNull();
    expect(box.current!['x-atlas-space-token']).toBe('space-only');
    expect(box.current!['x-atlas-all-access-secret']).toBeUndefined();
  });
});
