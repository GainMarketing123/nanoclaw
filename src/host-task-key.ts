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
    } catch (err) {
      // ENOENT is the expected fail-closed case (key not provisioned on this
      // host yet) and stays silent. Surface anything else (permission/IO) so a
      // misconfigured secret is observable rather than silently fail-closed
      // (cross-review cd490b3 F1).
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        console.warn(
          `host-task key: unexpected error reading ${path}: ${String(err)}`,
        );
      }
    }
  }

  return Buffer.alloc(0);
}
