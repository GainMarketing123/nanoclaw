import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIN_KEY_BYTES = 32;
const STRICT_HEX_RE = /^[0-9a-fA-F]+$/;

function decodeHexKey(text: string): Buffer {
  const raw = text.trim();
  if (!STRICT_HEX_RE.test(raw) || raw.length % 2 !== 0) {
    return Buffer.alloc(0);
  }

  const key = Buffer.from(raw, 'hex');
  if (key.length < MIN_KEY_BYTES) {
    return Buffer.alloc(0);
  }
  return key;
}

export function loadHostTaskKey(etcPath?: string): Buffer {
  const paths: string[] = [];
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (credentialsDirectory) {
    paths.push(join(credentialsDirectory, 'host-task-hmac'));
  }
  paths.push(etcPath ?? '/etc/atlas/host-task-hmac.secret');

  for (const path of paths) {
    try {
      const key = decodeHexKey(readFileSync(path, 'utf8'));
      if (key.length >= MIN_KEY_BYTES) {
        return key;
      }
    } catch {
      // Try next path.
    }
  }

  return Buffer.alloc(0);
}
