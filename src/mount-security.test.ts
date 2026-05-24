import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-sec-'));
  return {
    base,
    dataDir: path.join(base, 'data'),
    allowlistPath: path.join(base, 'allowlist.json'),
    homeDir: base,
  };
});

vi.mock('./config.js', () => ({
  DATA_DIR: h.dataDir,
  MOUNT_ALLOWLIST_PATH: h.allowlistPath,
  HOME_DIR: h.homeDir,
}));

import { validateMount } from './mount-security.js';

describe('mount-security SEC-1 hardening #6', () => {
  beforeAll(() => {
    fs.mkdirSync(h.dataDir, { recursive: true });
    fs.mkdirSync(path.join(h.dataDir, 'ipc', 'groupA'), { recursive: true });
    fs.mkdirSync(path.join(h.base, 'allowed'), { recursive: true });
    fs.mkdirSync(path.join(h.dataDir, 'governance-state'), { recursive: true });

    fs.writeFileSync(
      h.allowlistPath,
      JSON.stringify(
        {
          allowedRoots: [
            {
              path: path.join(h.base, 'allowed'),
              allowReadWrite: true,
            },
          ],
          blockedPatterns: [],
          nonMainReadOnly: false,
        },
        null,
        2,
      ),
    );
  });

  it('rejects host paths under DATA_DIR/ipc regardless of allowlist', () => {
    const result = validateMount(
      {
        hostPath: path.join(h.dataDir, 'ipc', 'groupA'),
        containerPath: 'foo',
      },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/IPC root|hardening #6/i);
  });

  it('allows an explicitly allowed non-IPC root', () => {
    const result = validateMount(
      {
        hostPath: path.join(h.base, 'allowed'),
        containerPath: 'foo',
      },
      false,
    );

    expect(result.allowed).toBe(true);
  });

  it('does not apply hardening #6 to DATA_DIR paths outside ipc', () => {
    const result = validateMount(
      {
        hostPath: path.join(h.dataDir, 'governance-state'),
        containerPath: 'foo',
      },
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).not.toMatch(/IPC root|hardening #6/i);
  });
});
