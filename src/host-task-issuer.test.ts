import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { HostTaskPolicy } from './host-task-policy.js';
import {
  HOST_TASK_RATE_MAX,
  evaluateHostTaskRequest,
  hostTaskRateOk,
  writeSignedHostTask,
} from './host-task-issuer.js';
import { HostTask, verify } from './host-task-sign.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('host-task-issuer', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('valid request returns signed task and verify passes', () => {
    const root = makeTempDir('host-task-issuer-valid-root-');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a', 'model-b'],
    };
    const key = Buffer.from('11'.repeat(32), 'hex');
    const now = 1_717_000_000;

    const result = evaluateHostTaskRequest(
      {
        prompt: 'run task',
        project_dir: project,
        tier: 2,
        model: 'model-b',
      },
      'group-a',
      'jid-a@test',
      policy,
      key,
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(verify(result.task, key, now)).toEqual({ ok: true, reason: 'ok' });
    // callback_group carries the caller-resolved registered chat JID — the
    // executor emits it as the IPC chatJid, so it must be JID-shaped, not the
    // group folder name (cross-review 44a873d1 F1).
    expect(result.task.callback_group).toBe('jid-a@test');
  });

  it('callback_group is the resolved JID and ignores data.callback_group', () => {
    const root = makeTempDir('host-task-issuer-callback-root-');
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a'],
    };

    const result = evaluateHostTaskRequest(
      {
        prompt: 'run task',
        project_dir: root,
        callback_group: 'attacker-jid@evil',
      },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.from('99'.repeat(32), 'hex'),
      1_717_000_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.task.callback_group).toBe('jid-a@test');
  });

  it('entity always comes from policy and ignores data.entity', () => {
    const root = makeTempDir('host-task-issuer-entity-root-');
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a'],
    };

    const result = evaluateHostTaskRequest(
      {
        prompt: 'run task',
        project_dir: root,
        entity: 'attacker-entity',
      },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.from('22'.repeat(32), 'hex'),
      1_717_000_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.task.entity).toBe('policy-entity');
  });

  it('tier clamps to max_tier and preserves an in-range tier', () => {
    const root = makeTempDir('host-task-issuer-tier-root-');
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a'],
    };
    const key = Buffer.from('33'.repeat(32), 'hex');
    const now = 1_717_000_000;

    const clamped = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: root, tier: 5 },
      'group-a',
      'jid-a@test',
      policy,
      key,
      now,
    );
    expect(clamped.ok).toBe(true);
    if (clamped.ok) {
      expect(clamped.task.tier).toBe(3);
    }

    const preserved = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: root, tier: 2 },
      'group-a',
      'jid-a@test',
      policy,
      key,
      now,
    );
    expect(preserved.ok).toBe(true);
    if (preserved.ok) {
      expect(preserved.task.tier).toBe(2);
    }
  });

  it('out-of-allowlist model clamps to allowed_models[0]', () => {
    const root = makeTempDir('host-task-issuer-model-root-');
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-default', 'model-other'],
    };

    const result = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: root, model: 'bad-model' },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.from('44'.repeat(32), 'hex'),
      1_717_000_000,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.model).toBe('model-default');
    }
  });

  it('returns project_dir_not_allowed for path outside allowlist', () => {
    const allowedRoot = makeTempDir('host-task-issuer-allowed-root-');
    const outsideRoot = makeTempDir('host-task-issuer-outside-root-');
    cleanupPaths.push(allowedRoot, outsideRoot);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [allowedRoot],
      allowed_models: ['model-a'],
    };

    const result = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: outsideRoot },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.from('55'.repeat(32), 'hex'),
      1_717_000_000,
    );

    expect(result).toEqual({ ok: false, reason: 'project_dir_not_allowed' });
  });

  it('rejects a ../ escape that resolves outside the allowed root', () => {
    const parent = makeTempDir('host-task-issuer-escape-parent-');
    const allowedRoot = join(parent, 'allowed');
    const sibling = join(parent, 'sibling');
    mkdirSync(allowedRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    cleanupPaths.push(parent);

    const escapePath = `${allowedRoot}/../sibling`;
    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [allowedRoot],
      allowed_models: ['model-a'],
    };

    const result = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: escapePath },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.from('66'.repeat(32), 'hex'),
      1_717_000_000,
    );

    expect(result).toEqual({ ok: false, reason: 'project_dir_not_allowed' });
  });

  it('returns missing_prompt when prompt is missing', () => {
    const root = makeTempDir('host-task-issuer-missing-prompt-root-');
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a'],
    };

    const result = evaluateHostTaskRequest(
      { project_dir: root },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.from('77'.repeat(32), 'hex'),
      1_717_000_000,
    );

    expect(result).toEqual({ ok: false, reason: 'missing_prompt' });
  });

  it('returns no_key for empty key', () => {
    const root = makeTempDir('host-task-issuer-no-key-root-');
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a'],
    };

    const result = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: root },
      'group-a',
      'jid-a@test',
      policy,
      Buffer.alloc(0),
      1_717_000_000,
    );

    expect(result).toEqual({ ok: false, reason: 'no_key' });
  });

  it('writeSignedHostTask round-trips and verify passes', () => {
    const atlasDir = makeTempDir('host-task-issuer-atlas-');
    const root = makeTempDir('host-task-issuer-roundtrip-root-');
    cleanupPaths.push(atlasDir, root);

    const policy: HostTaskPolicy = {
      entity: 'policy-entity',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['model-a'],
    };
    const key = Buffer.from('88'.repeat(32), 'hex');
    const now = 1_717_000_000;

    const evalResult = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: root },
      'group-a',
      'jid-a@test',
      policy,
      key,
      now,
    );
    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) {
      return;
    }

    writeSignedHostTask(evalResult.task, atlasDir);
    const writtenPath = join(
      atlasDir,
      'host-tasks',
      'pending',
      `${evalResult.task.task_id}.json`,
    );

    const parsed = JSON.parse(readFileSync(writtenPath, 'utf8')) as HostTask;
    expect(verify(parsed, key, now)).toEqual({ ok: true, reason: 'ok' });
  });

  it('hostTaskRateOk allows up to max calls then rejects', () => {
    const group = `group-rate-${Date.now()}-${Math.random()}`;
    const now = 1_700_000_000_000;

    for (let i = 0; i < HOST_TASK_RATE_MAX; i++) {
      expect(hostTaskRateOk(group, now)).toBe(true);
    }
    expect(hostTaskRateOk(group, now)).toBe(false);
  });
});
