import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';

import { HostTaskPolicy } from './host-task-policy.js';
import { HostTask, SCHEMA_VERSION, sign } from './host-task-sign.js';

export const HOST_TASK_TTL_S = 3600;
export const HOST_TASK_RATE_WINDOW_MS = 60000;
export const HOST_TASK_RATE_MAX = 10;

export type EvalResult =
  | { ok: true; task: HostTask }
  | { ok: false; reason: string };

const rateByGroup = new Map<string, number[]>();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function evaluateHostTaskRequest(
  data: unknown,
  sourceGroup: string,
  policy: HostTaskPolicy,
  key: Buffer,
  now: number,
): EvalResult {
  // Require the full key size the signer expects (cross-review 3a75c45 F3).
  // loadHostTaskKey already returns empty or >=32 bytes; this also rejects a
  // short key passed directly by any other caller before it reaches sign().
  if (key.length < 32) {
    return { ok: false, reason: 'no_key' };
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  if (!isNonEmptyString(payload.prompt)) {
    return { ok: false, reason: 'missing_prompt' };
  }
  if (!isNonEmptyString(payload.project_dir)) {
    return { ok: false, reason: 'missing_project_dir' };
  }

  const entity = policy.entity;
  const requestedTier = Number.isInteger(payload.tier)
    ? (payload.tier as number)
    : policy.max_tier;
  const tier = Math.max(1, Math.min(requestedTier, policy.max_tier));

  const model =
    typeof payload.model === 'string' &&
    policy.allowed_models.includes(payload.model)
      ? payload.model
      : policy.allowed_models[0];
  if (!model) {
    return { ok: false, reason: 'no_allowed_model' };
  }

  let realDir: string;
  try {
    realDir = realpathSync(payload.project_dir);
  } catch {
    return { ok: false, reason: 'project_dir_unresolvable' };
  }

  let allowed = false;
  for (const root of policy.allowed_project_dirs) {
    if (!isAbsolute(root)) {
      continue;
    }
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (realDir === realRoot || realDir.startsWith(realRoot + sep)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    return { ok: false, reason: 'project_dir_not_allowed' };
  }

  const task: HostTask = {
    task_id: `ht-${Date.now()}-${randomBytes(4).toString('hex')}`,
    source_group: sourceGroup,
    entity,
    tier,
    model,
    project_dir: realDir,
    prompt: payload.prompt,
    // callback_group is ALWAYS the requester's own group, never a container
    // claim (cross-review 3a75c45 F1): the executor routes results by this
    // field, so honoring a container-supplied value would enable cross-group
    // result delivery / exfiltration.
    callback_group: sourceGroup,
    nonce: randomBytes(16).toString('hex'),
    issued_at: now,
    expires_at: now + HOST_TASK_TTL_S,
    schema_version: SCHEMA_VERSION,
  };
  task._sig = sign(task, key);

  return { ok: true, task };
}

export function writeSignedHostTask(task: HostTask, atlasDir: string): void {
  const pendingDir = join(atlasDir, 'host-tasks', 'pending');
  mkdirSync(pendingDir, { recursive: true });

  const finalPath = join(pendingDir, `${task.task_id}.json`);
  const tempPath = join(
    pendingDir,
    `${task.task_id}.${randomBytes(8).toString('hex')}.tmp`,
  );

  const fd = openSync(tempPath, 'w');
  try {
    writeFileSync(fd, JSON.stringify(task, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Exclusive publish (cross-review 0ac2f6a F2): linkSync fails EEXIST on a
  // task_id collision instead of silently overwriting an already-queued task
  // the way renameSync would. TOCTOU-free. On success the final path is a
  // hardlink to the fully-written+fsync'd temp; unlink the temp, leaving the
  // durable final. A collision throws out to the caller's logged rejection.
  try {
    linkSync(tempPath, finalPath);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // temp already removed
    }
  }

  const dirFd = openSync(pendingDir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function hostTaskRateOk(
  group: string,
  now: number = Date.now(),
): boolean {
  const minTs = now - HOST_TASK_RATE_WINDOW_MS;
  const kept = (rateByGroup.get(group) ?? []).filter((ts) => ts > minTs);
  if (kept.length >= HOST_TASK_RATE_MAX) {
    rateByGroup.set(group, kept);
    return false;
  }
  kept.push(now);
  rateByGroup.set(group, kept);
  return true;
}
