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
