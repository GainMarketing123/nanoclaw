import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { HostTaskPolicy } from './host-task-policy.js';
import { evaluateHostTaskRequest } from './host-task-issuer.js';
import { verify } from './host-task-sign.js';
import { resolveCallbackJid } from './ipc.js';
import { RegisteredGroup } from './types.js';

/**
 * Round-trip coverage for the host-task callback_group fix (cross-review
 * 44a873d1 F1; SEC-1 live-test defect — completed tasks carried
 * callback_group:"" so results never routed back to the requester chat).
 *
 * The existing issuer tests pass an already-resolved `callbackJid` literal and
 * never exercise the folder -> JID resolution that src/ipc.ts performs at issue
 * time. This file closes that gap end-to-end using the SAME resolver the
 * production host_task case uses (resolveCallbackJid), so a regression in the
 * resolver — not just the issuer — is caught.
 *
 * Path proven here: requester `sourceGroup` folder -> resolveCallbackJid over
 * registeredGroups -> JID -> evaluateHostTaskRequest stamps it into the SIGNED
 * task before sign() -> verify() succeeds under the same key and the signed
 * callback_group is the resolved chat JID.
 */
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function group(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '',
    added_at: '2026-06-11T00:00:00.000Z',
  };
}

describe('host-task callback_group round-trip (folder -> JID -> signed task)', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  describe('resolveCallbackJid (pure resolver)', () => {
    it('resolves a folder to its registered, DELIVERABLE chat JID', () => {
      const registeredGroups: Record<string, RegisteredGroup> = {
        'msteams:a:1BURQ': group('atlas_teams'),
        'tg:7322433447': group('atlas_main'),
      };
      expect(resolveCallbackJid(registeredGroups, 'atlas_teams')).toBe(
        'msteams:a:1BURQ',
      );
    });

    it('skips a non-deliverable dispatch: alias and returns "" when that is the only JID', () => {
      // cross-review F2: a bridge company workspace is registered under a
      // logical `dispatch:{folder}` alias that no outbound channel owns. The
      // result-delivery message path does not resolve dispatch→real, so a
      // dispatch callback_group would route the result to data/ipc/errors.
      // Return '' (skip delivery, best-effort) rather than an undeliverable JID.
      const registeredGroups: Record<string, RegisteredGroup> = {
        'dispatch:atlas_gpg': group('atlas_gpg'),
      };
      expect(resolveCallbackJid(registeredGroups, 'atlas_gpg')).toBe('');
    });

    it('prefers a real channel JID over a dispatch alias for the same folder', () => {
      // If a folder somehow has BOTH a dispatch alias and a real channel JID,
      // the deliverable real JID wins regardless of iteration order.
      const dispatchFirst: Record<string, RegisteredGroup> = {
        'dispatch:atlas_gpg': group('atlas_gpg'),
        'msteams:a:gpg': group('atlas_gpg'),
      };
      expect(resolveCallbackJid(dispatchFirst, 'atlas_gpg')).toBe(
        'msteams:a:gpg',
      );
    });

    it('skips a retired-channel JID and returns "" when it is the only JID', () => {
      // cross-review FAIL_BLOCKING R3: a retired-channel JID (e.g. a leftover
      // `tg:` row after the Telegram retirement) is guaranteed to raise
      // RetiredChannelDropError on send, so it must NOT be stamped as
      // callback_group — that would hand the executor a JID whose only outcome
      // is a dropped result. Best-effort skip ('') instead.
      const registeredGroups: Record<string, RegisteredGroup> = {
        'tg:7322433447': group('atlas_main'),
      };
      expect(resolveCallbackJid(registeredGroups, 'atlas_main')).toBe('');
    });

    it('prefers a live channel JID over a retired one for the same folder', () => {
      const retiredFirst: Record<string, RegisteredGroup> = {
        'tg:7322433447': group('atlas_main'),
        'msteams:a:main': group('atlas_main'),
      };
      expect(resolveCallbackJid(retiredFirst, 'atlas_main')).toBe(
        'msteams:a:main',
      );
    });

    it('returns empty string when no registered group owns the folder', () => {
      const registeredGroups: Record<string, RegisteredGroup> = {
        'msteams:a:1BURQ': group('atlas_teams'),
      };
      // SEC-1 live defect shape: the requester folder has no registered JID, so
      // the executor must skip delivery rather than route to a folder name.
      expect(resolveCallbackJid(registeredGroups, 'atlas_unregistered')).toBe(
        '',
      );
      expect(resolveCallbackJid({}, 'atlas_teams')).toBe('');
    });
  });

  it('carries the resolved requester JID into the signed task and verifies', () => {
    const root = makeTempDir('host-task-cb-roundtrip-');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'atlas',
      max_tier: 3,
      allowed_project_dirs: [root],
      allowed_models: ['haiku', 'sonnet'],
    };
    const key = Buffer.from('ab'.repeat(32), 'hex');
    const now = 1_717_000_000;

    // The requester is the Teams group, identified ONLY by its unforgeable
    // directory-derived folder name — exactly what src/ipc.ts has at issue time.
    const sourceGroup = 'atlas_teams';
    const teamsJid = 'msteams:a:1BURQLVbTugEhlj-';
    const registeredGroups: Record<string, RegisteredGroup> = {
      [teamsJid]: group('atlas_teams'),
      'dispatch:atlas_gpg': group('atlas_gpg'),
    };

    // Production wiring: resolve folder -> JID, then issue.
    const callbackJid = resolveCallbackJid(registeredGroups, sourceGroup);
    expect(callbackJid).toBe(teamsJid);

    const result = evaluateHostTaskRequest(
      { prompt: 'run git status', project_dir: project, model: 'haiku' },
      sourceGroup,
      callbackJid,
      policy,
      key,
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The signed task carries the resolved chat JID (not the folder name, not
    // empty), and the signature covers it (canonicalSigInput.cb).
    expect(result.task.callback_group).toBe(teamsJid);
    expect(verify(result.task, key, now)).toEqual({ ok: true, reason: 'ok' });

    // The same key round-trips; a different key fails (callback_group is signed).
    const otherKey = Buffer.from('cd'.repeat(32), 'hex');
    expect(verify(result.task, otherKey, now).ok).toBe(false);
  });

  it('unresolvable requester folder REJECTS issuance (populate-or-fail-closed)', () => {
    const root = makeTempDir('host-task-cb-empty-');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'atlas',
      max_tier: 2,
      allowed_project_dirs: [root],
      allowed_models: ['haiku'],
    };
    const key = Buffer.from('77'.repeat(32), 'hex');
    const now = 1_717_000_000;

    // Folder has no registered channel JID. The OLD contract signed the task
    // with callback_group:'' best-effort and let the executor silently skip
    // result delivery — work that runs while its outcome (including failure
    // output) is delivered to no one. al22 wave-3: the issuer now fails
    // closed at the root instead.
    const callbackJid = resolveCallbackJid({}, 'atlas_orphan');
    expect(callbackJid).toBe('');

    const result = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: project },
      'atlas_orphan',
      callbackJid,
      policy,
      key,
      now,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('no_deliverable_callback');
  });

  it('a folder registered ONLY under a dispatch: alias also rejects issuance', () => {
    // The resolver skips alias rows (no outbound channel owns them), so the
    // issuer's fail-closed gate fires for alias-only folders too — same
    // contract, one resolver, one rejection point.
    const root = makeTempDir('host-task-cb-alias-');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    cleanupPaths.push(root);

    const policy: HostTaskPolicy = {
      entity: 'gpg',
      max_tier: 1,
      allowed_project_dirs: [root],
      allowed_models: ['haiku'],
    };
    const key = Buffer.from('88'.repeat(32), 'hex');
    const now = 1_717_000_000;

    const callbackJid = resolveCallbackJid(
      { 'dispatch:atlas_gpg': group('atlas_gpg') },
      'atlas_gpg',
    );
    expect(callbackJid).toBe('');

    const result = evaluateHostTaskRequest(
      { prompt: 'run task', project_dir: project },
      'atlas_gpg',
      callbackJid,
      policy,
      key,
      now,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('no_deliverable_callback');
  });
});
