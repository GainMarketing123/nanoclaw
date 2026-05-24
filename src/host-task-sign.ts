import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SCHEMA_VERSION = 'ht1';

export interface HostTask {
  task_id: string;
  source_group: string;
  entity: string;
  tier: number;
  model: string;
  project_dir: string;
  prompt: string;
  callback_group: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
  schema_version: string;
  _sig?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

export function canonicalSigInput(
  task: HostTask,
): Record<string, string | number> {
  return {
    cb: sha256Hex(task.callback_group),
    ent: task.entity,
    exp: task.expires_at,
    grp: task.source_group,
    iat: task.issued_at,
    model: task.model,
    nonce: task.nonce,
    pdir: sha256Hex(task.project_dir),
    ph: sha256Hex(task.prompt),
    tid: task.task_id,
    tier: task.tier,
    v: task.schema_version,
  };
}

function escapeAsciiJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x22) {
      out += '\\"';
    } else if (ch === 0x5c) {
      out += '\\\\';
    } else if (ch === 0x08) {
      out += '\\b';
    } else if (ch === 0x0c) {
      out += '\\f';
    } else if (ch === 0x0a) {
      out += '\\n';
    } else if (ch === 0x0d) {
      out += '\\r';
    } else if (ch === 0x09) {
      out += '\\t';
    } else if (ch < 0x20 || ch > 0x7e) {
      out += `\\u${ch.toString(16).padStart(4, '0')}`;
    } else {
      out += value[i];
    }
  }
  out += '"';
  return out;
}

export function canonicalBytes(task: HostTask): Buffer {
  const sigInput = canonicalSigInput(task);
  const keys = Object.keys(sigInput).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = sigInput[key];
    const keyPart = escapeAsciiJsonString(key);
    if (typeof value === 'number') {
      parts.push(`${keyPart}:${value}`);
    } else {
      parts.push(`${keyPart}:${escapeAsciiJsonString(value)}`);
    }
  }
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

export function sign(task: HostTask, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalBytes(task)).digest('hex');
}

function isHexString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    /^[0-9a-fA-F]+$/.test(value)
  );
}

// Fields canonicalSigInput() reads. If any is missing or a hashed string field
// is the wrong type, sign() throws (sha256Hex -> Buffer.from(undefined)).
// verify() must fail closed with a reason, never throw on hostile queue input
// (cross-review F2). Mirrors the Python _validate_shape().
const REQUIRED_STRING_FIELDS = [
  'task_id',
  'source_group',
  'entity',
  'model',
  'project_dir',
  'prompt',
  'callback_group',
  'nonce',
] as const;
const REQUIRED_NUMBER_FIELDS = ['tier', 'issued_at', 'expires_at'] as const;

function validateShape(task: HostTask): string | null {
  const record = task as unknown as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string') {
      return 'bad_task';
    }
  }
  for (const field of REQUIRED_NUMBER_FIELDS) {
    // Require an actual integer, not merely "defined" — null/string/float
    // would pass an undefined-only check and then throw in canonicalBytes
    // (escapeAsciiJsonString(null).length) instead of failing closed
    // (cross-review round 2). Matches the Python `type(...) is int` check.
    if (!Number.isInteger(record[field])) {
      return 'bad_task';
    }
  }
  return null;
}

export function verify(
  task: HostTask,
  key: Buffer,
  now: number,
  maxSkew = 60,
): { ok: boolean; reason: string } {
  if (task.schema_version !== SCHEMA_VERSION) {
    return { ok: false, reason: 'bad_schema' };
  }

  if (!isHexString(task._sig)) {
    return { ok: false, reason: 'missing_sig' };
  }

  // Validate shape BEFORE signing so a malformed/hostile task fails closed
  // with a reason instead of throwing inside canonicalSigInput()/sign()
  // (cross-review F2).
  const shapeReason = validateShape(task);
  if (shapeReason !== null) {
    return { ok: false, reason: shapeReason };
  }

  const expected = Buffer.from(sign(task, key), 'hex');
  const given = Buffer.from(task._sig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_sig' };
  }

  // Numeric type validation lives in validateShape() (pre-sign), so by here
  // tier/issued_at/expires_at are already integers. No separate bad_types
  // branch — it was unreachable dead code (cross-review round 3).
  if (now > task.expires_at) {
    return { ok: false, reason: 'expired' };
  }

  if (task.issued_at > now + maxSkew) {
    return { ok: false, reason: 'future' };
  }

  return { ok: true, reason: 'ok' };
}
