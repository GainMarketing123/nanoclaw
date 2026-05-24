import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HostTaskPolicy,
  loadHostTaskPolicy,
  policyForGroup,
} from './host-task-policy.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('host-task-policy', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('parses a valid policy file', () => {
    const dir = makeTempDir('host-task-policy-valid-');
    cleanupPaths.push(dir);
    const policyPath = join(dir, 'host-task-policy.json');

    const expected: Record<string, HostTaskPolicy> = {
      alpha: {
        entity: 'team-alpha',
        max_tier: 2,
        allowed_project_dirs: ['/srv/alpha'],
        allowed_models: ['claude-sonnet-4-5'],
      },
    };
    writeFileSync(policyPath, JSON.stringify(expected), 'utf8');

    expect(loadHostTaskPolicy(policyPath)).toEqual(expected);
  });

  it('returns empty object for absent and malformed files', () => {
    const dir = makeTempDir('host-task-policy-bad-');
    cleanupPaths.push(dir);

    expect(loadHostTaskPolicy(join(dir, 'missing.json'))).toEqual({});

    const malformedPath = join(dir, 'malformed.json');
    writeFileSync(malformedPath, '{ not-json', 'utf8');
    expect(loadHostTaskPolicy(malformedPath)).toEqual({});
  });

  it('policyForGroup returns entry for known group and null for unknown group', () => {
    const dir = makeTempDir('host-task-policy-group-');
    cleanupPaths.push(dir);
    const policyPath = join(dir, 'policy.json');
    writeFileSync(
      policyPath,
      JSON.stringify({
        known: {
          entity: 'known-entity',
          max_tier: 3,
          allowed_project_dirs: ['/srv/known'],
          allowed_models: ['model-a'],
        },
      }),
      'utf8',
    );

    expect(policyForGroup('known', policyPath)).toEqual({
      entity: 'known-entity',
      max_tier: 3,
      allowed_project_dirs: ['/srv/known'],
      allowed_models: ['model-a'],
    });
    expect(policyForGroup('unknown', policyPath)).toBeNull();
  });

  it('drops invalid entries while preserving valid siblings', () => {
    const dir = makeTempDir('host-task-policy-shape-');
    cleanupPaths.push(dir);
    const policyPath = join(dir, 'policy.json');

    writeFileSync(
      policyPath,
      JSON.stringify({
        valid: {
          entity: 'ok',
          max_tier: 1,
          allowed_project_dirs: ['/srv/ok'],
          allowed_models: ['model-ok'],
        },
        invalid: {
          entity: 'bad',
          max_tier: 1.5,
          allowed_project_dirs: ['/srv/bad'],
          allowed_models: ['model-bad'],
        },
      }),
      'utf8',
    );

    expect(loadHostTaskPolicy(policyPath)).toEqual({
      valid: {
        entity: 'ok',
        max_tier: 1,
        allowed_project_dirs: ['/srv/ok'],
        allowed_models: ['model-ok'],
      },
    });
  });
});
