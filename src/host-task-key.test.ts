import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { loadHostTaskKey } from './host-task-key.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('host-task-key', () => {
  const originalCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  const cleanupPaths: string[] = [];

  afterEach(() => {
    if (originalCredentialsDirectory === undefined) {
      delete process.env.CREDENTIALS_DIRECTORY;
    } else {
      process.env.CREDENTIALS_DIRECTORY = originalCredentialsDirectory;
    }

    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('returns matching bytes from valid hex in CREDENTIALS_DIRECTORY', () => {
    const dir = makeTempDir('host-task-key-valid-');
    cleanupPaths.push(dir);
    const key = Buffer.alloc(32, 0xab);
    writeFileSync(
      join(dir, 'host-task-hmac'),
      key.toString('hex') + '\n',
      'utf8',
    );
    process.env.CREDENTIALS_DIRECTORY = dir;

    expect(loadHostTaskKey(join(dir, 'unused-fallback.secret'))).toEqual(key);
  });

  it('returns empty buffer for malformed hex input', () => {
    const dir = makeTempDir('host-task-key-malformed-');
    cleanupPaths.push(dir);
    writeFileSync(join(dir, 'host-task-hmac'), 'zz11', 'utf8');
    process.env.CREDENTIALS_DIRECTORY = dir;

    expect(loadHostTaskKey(join(dir, 'missing.secret'))).toEqual(
      Buffer.alloc(0),
    );
  });

  it('returns empty buffer for odd-length hex input', () => {
    const dir = makeTempDir('host-task-key-odd-');
    cleanupPaths.push(dir);
    writeFileSync(join(dir, 'host-task-hmac'), 'abc', 'utf8');
    process.env.CREDENTIALS_DIRECTORY = dir;

    expect(loadHostTaskKey(join(dir, 'missing.secret'))).toEqual(
      Buffer.alloc(0),
    );
  });

  it('returns empty buffer for decoded key shorter than 32 bytes', () => {
    const dir = makeTempDir('host-task-key-short-');
    cleanupPaths.push(dir);
    writeFileSync(
      join(dir, 'host-task-hmac'),
      Buffer.alloc(31, 0x11).toString('hex'),
      'utf8',
    );
    process.env.CREDENTIALS_DIRECTORY = dir;

    expect(loadHostTaskKey(join(dir, 'missing.secret'))).toEqual(
      Buffer.alloc(0),
    );
  });

  it('returns empty buffer when no key file exists', () => {
    const dir = makeTempDir('host-task-key-absent-');
    cleanupPaths.push(dir);
    process.env.CREDENTIALS_DIRECTORY = dir;

    expect(loadHostTaskKey(join(dir, 'missing.secret'))).toEqual(
      Buffer.alloc(0),
    );
  });

  it('uses etcPath override when CREDENTIALS_DIRECTORY is unset', () => {
    const dir = makeTempDir('host-task-key-etc-');
    cleanupPaths.push(dir);
    delete process.env.CREDENTIALS_DIRECTORY;

    const etcDir = join(dir, 'etc');
    mkdirSync(etcDir);
    const etcPath = join(etcDir, 'host-task-hmac.secret');
    const key = Buffer.alloc(32, 0xcd);
    writeFileSync(etcPath, key.toString('hex'), 'utf8');

    expect(loadHostTaskKey(etcPath)).toEqual(key);
  });
});
