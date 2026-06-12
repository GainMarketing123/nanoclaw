import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _setGroupIsMainUnchecked,
  getAllChats,
  getAllRegisteredGroups,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import {
  ensureOwnerMainGroup,
  getAvailableGroups,
  _loadState,
  _setRegisteredGroups,
} from './index.js';
import {
  isKnownUndeliverableJid,
  resolveChannelJidForFolder,
  resolveSeedTarget,
  selectLiveMain,
  selectLiveMainJid,
} from './router.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- selectLiveMainJid (retirement-aware main selection) ---

describe('selectLiveMainJid', () => {
  it('never selects a retired-channel JID, even when it is the only candidate', () => {
    expect(selectLiveMainJid([{ jid: 'tg:7322433447', folder: 'main' }])).toBe(
      undefined,
    );
  });

  it('prefers a live JID over a retired one regardless of folder', () => {
    // The dead Telegram row may hold the canonical folder 'main' (the schema
    // migration promotes `folder = 'main'`); liveness must still win.
    expect(
      selectLiveMainJid([
        { jid: 'tg:7322433447', folder: 'main' },
        { jid: 'msteams:a:owner', folder: 'atlas_teams' },
      ]),
    ).toBe('msteams:a:owner');
  });

  it('prefers the canonical folder === "main" row among live candidates', () => {
    expect(
      selectLiveMainJid([
        { jid: 'msteams:a:other', folder: 'atlas_teams' },
        { jid: 'whatsapp-main@s.whatsapp.net', folder: 'main' },
      ]),
    ).toBe('whatsapp-main@s.whatsapp.net');
  });

  it('falls back to the lexicographically-smallest jid when none has folder "main"', () => {
    // NOT first-in-array: candidates come from a SELECT with no ORDER BY,
    // so array order is SQLite row order — undefined, and not guaranteed to
    // match what another runtime mirror sees (codex 20924e0 finding 1).
    expect(
      selectLiveMainJid([
        { jid: 'msteams:a:first', folder: 'atlas_teams' },
        { jid: 'dc:123', folder: 'discord_general' },
      ]),
    ).toBe('dc:123');
  });

  it('tie-break is deterministic — input order never changes the winner', () => {
    // The round-2 review scenario: two live mains, neither folder literally
    // 'main' (legacy 'atlas_main' alongside 'atlas_teams'). Every runtime
    // (router.ts callers, host-executor.py, create-group.sh) must agree on
    // one canonical row no matter what order the DB returns rows in.
    const a = { jid: 'msteams:a:teams', folder: 'atlas_teams' };
    const b = { jid: 'whatsapp-x@s.whatsapp.net', folder: 'atlas_main' };
    expect(selectLiveMainJid([a, b])).toBe('msteams:a:teams');
    expect(selectLiveMainJid([b, a])).toBe('msteams:a:teams');
  });

  it('canonical folder "main" beats a smaller jid', () => {
    // Folder rank dominates the jid tie-break — the schema migration
    // promotes folder='main', so that row stays the survivor everywhere.
    expect(
      selectLiveMainJid([
        { jid: 'aaa@s.whatsapp.net', folder: 'atlas_main' },
        { jid: 'zzz@s.whatsapp.net', folder: 'main' },
      ]),
    ).toBe('zzz@s.whatsapp.net');
  });

  it('returns undefined for an empty candidate list', () => {
    expect(selectLiveMainJid([])).toBe(undefined);
  });

  it('selectLiveMain returns the full row — privileged IPC writers need the folder too', () => {
    // host-executor.py / credential-proxy.ts emit alerts from the live
    // main's OWN IPC source dir (the watcher authorizes by main-folder
    // match), so the selection must expose the folder, not just the jid.
    expect(
      selectLiveMain([
        { jid: 'tg:7322433447', folder: 'main' },
        { jid: 'msteams:a:owner', folder: 'atlas_teams' },
      ]),
    ).toEqual({ jid: 'msteams:a:owner', folder: 'atlas_teams' });
  });
});

// --- isKnownUndeliverableJid (shared conservative deliverability predicate) ---

describe('isKnownUndeliverableJid', () => {
  it('flags retired-channel JIDs (tg:)', () => {
    expect(isKnownUndeliverableJid('tg:7322433447')).toBe(true);
  });

  it('flags logical dispatch: aliases', () => {
    expect(isKnownUndeliverableJid('dispatch:atlas_gpg')).toBe(true);
  });

  it('does NOT flag real channel JID shapes', () => {
    expect(isKnownUndeliverableJid('msteams:a:owner')).toBe(false);
    expect(isKnownUndeliverableJid('12345678@g.us')).toBe(false);
    expect(isKnownUndeliverableJid('dc:123')).toBe(false);
  });

  it('is conservative: an unmapped-but-plausible JID is NOT flagged', () => {
    // The predicate is shape-only — a channel may be down or unregistered at
    // send time, and runtime ownership stays the authoritative check. The
    // helper must never claim a plausible channel JID is dead.
    expect(isKnownUndeliverableJid('typo-unmapped-jid')).toBe(false);
  });
});

// --- resolveChannelJidForFolder (folder -> registered channel JID) ---

describe('resolveChannelJidForFolder', () => {
  it('resolves a folder to its registered channel JID', () => {
    expect(
      resolveChannelJidForFolder(
        {
          'msteams:a:owner': { folder: 'atlas_teams' },
          'dc:123': { folder: 'discord_general' },
        },
        'atlas_teams',
      ),
    ).toBe('msteams:a:owner');
  });

  it('skips dispatch aliases and retired rows for the same folder', () => {
    expect(
      resolveChannelJidForFolder(
        {
          'dispatch:atlas_gpg': { folder: 'atlas_gpg' },
          'tg:999': { folder: 'atlas_gpg' },
          'msteams:a:gpg': { folder: 'atlas_gpg' },
        },
        'atlas_gpg',
      ),
    ).toBe('msteams:a:gpg');
  });

  it('returns undefined when the folder has only undeliverable rows', () => {
    expect(
      resolveChannelJidForFolder(
        { 'dispatch:atlas_gpg': { folder: 'atlas_gpg' } },
        'atlas_gpg',
      ),
    ).toBe(undefined);
  });

  it('returns undefined when no row has the folder', () => {
    expect(resolveChannelJidForFolder({}, 'atlas_orphan')).toBe(undefined);
  });

  it('tie-break is deterministic — insertion order never changes the winner', () => {
    // Two stale-extra rows for one folder (transient in-memory state): the
    // lexicographically-smallest JID must win regardless of object insertion
    // order, mirroring selectLiveMain's jid tie-break.
    const aFirst = {
      'msteams:a:aaa': { folder: 'atlas_x' },
      'msteams:a:bbb': { folder: 'atlas_x' },
    };
    const bFirst = {
      'msteams:a:bbb': { folder: 'atlas_x' },
      'msteams:a:aaa': { folder: 'atlas_x' },
    };
    expect(resolveChannelJidForFolder(aFirst, 'atlas_x')).toBe('msteams:a:aaa');
    expect(resolveChannelJidForFolder(bFirst, 'atlas_x')).toBe('msteams:a:aaa');
  });
});

// --- resolveSeedTarget (seed-orchestrator target resolution) ---

describe('resolveSeedTarget', () => {
  const rows = [
    { jid: 'tg:7322433447', folder: 'main', isMain: true },
    { jid: 'msteams:a:owner', folder: 'atlas_teams', isMain: true },
    { jid: 'dispatch:atlas_gpg', folder: 'atlas_gpg', isMain: false },
    { jid: 'msteams:a:side', folder: 'atlas_side', isMain: false },
  ];

  it('explicit path: resolves a registered channel JID with ITS folder', () => {
    expect(resolveSeedTarget(rows, 'msteams:a:side')).toEqual({
      ok: true,
      jid: 'msteams:a:side',
      folder: 'atlas_side',
    });
  });

  it('explicit path: rejects an unregistered JID', () => {
    const result = resolveSeedTarget(rows, 'msteams:a:nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not a registered group JID');
    }
  });

  it('explicit path: rejects a registered retired-channel JID', () => {
    // Wave-2 round-2 finding 2: "registered" is not "deliverable".
    const result = resolveSeedTarget(rows, 'tg:7322433447');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('knowably');
    }
  });

  it('explicit path: rejects a registered dispatch: alias', () => {
    // Wave-2 round-3 finding 1: the alias is registered but no outbound
    // channel owns the prefix — the digest would run and never deliver.
    const result = resolveSeedTarget(rows, 'dispatch:atlas_gpg');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('knowably');
    }
  });

  it('default path: selects the live main with ITS folder, never a constant', () => {
    // Wave-2 round-0/round-1 findings: the seeder hard-coded atlas_main and
    // took WHERE is_main=1 LIMIT 1. The resolver must return the live main
    // row's own folder (the VPS reality: live main lives in atlas_teams).
    expect(resolveSeedTarget(rows)).toEqual({
      ok: true,
      jid: 'msteams:a:owner',
      folder: 'atlas_teams',
    });
  });

  it('default path: fails closed when every main row is undeliverable', () => {
    const result = resolveSeedTarget([
      { jid: 'tg:7322433447', folder: 'main', isMain: true },
      { jid: 'dispatch:atlas_gpg', folder: 'atlas_gpg', isMain: true },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('no live main group');
    }
  });

  it('default path: fails closed on an empty registry', () => {
    expect(resolveSeedTarget([]).ok).toBe(false);
  });
});

// --- selectLiveMain alias exclusion (al22 reland, commit-review round 1) ---

describe('selectLiveMain dispatch-alias exclusion', () => {
  it('never selects a dispatch: alias row, even as the only candidate', () => {
    // setRegisteredGroup now rejects promoting one, but a legacy/hand-edited
    // row must not win selection in any runtime mirror (host-executor.py and
    // create-group.sh carry the same filter in lockstep).
    expect(
      selectLiveMainJid([{ jid: 'dispatch:atlas_gpg', folder: 'atlas_gpg' }]),
    ).toBe(undefined);
    expect(
      selectLiveMainJid([
        { jid: 'dispatch:atlas_gpg', folder: 'main' },
        { jid: 'msteams:a:owner', folder: 'atlas_teams' },
      ]),
    ).toBe('msteams:a:owner');
  });
});

// --- loadState single-live-main normalization ---

describe('loadState single-live-main normalization', () => {
  it('durably demotes a sole retired-channel main (the 2026-06-11 VPS state)', () => {
    // A legacy Telegram main row survives the Teams migration as the only
    // is_main=1 row. Every DB-reading alert path would mis-route to it.
    // Seeded via the unchecked test helper: setRegisteredGroup now REJECTS
    // promoting a knowably-undeliverable JID to main (write-layer invariant),
    // but real pre-invariant DBs contain exactly this row — loadState must
    // still normalize it.
    setRegisteredGroup('tg:7322433447', {
      name: 'Telegram Main (dead)',
      folder: 'main',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    _setGroupIsMainUnchecked('tg:7322433447');

    _loadState();

    // Demotion must be persisted, not in-memory-only: send_alert and the
    // credential proxy read the DB directly.
    const groups = getAllRegisteredGroups();
    expect(groups['tg:7322433447'].isMain).toBeUndefined();
  });

  it('keeps a sole live-channel main untouched', () => {
    setRegisteredGroup('msteams:a:owner', {
      name: 'Atlas',
      folder: 'atlas_teams',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    _loadState();

    expect(getAllRegisteredGroups()['msteams:a:owner'].isMain).toBe(true);
  });
});

// --- ensureOwnerMainGroup re-promotion after a retired main is demoted ---

describe('ensureOwnerMainGroup', () => {
  it('re-promotes the registered owner chat when no live main exists', () => {
    // VPS state from the 2026-06-11 trace: the owner's Teams chat is already
    // registered (so the legacy "return early if registered" shape could
    // never promote it) and the only is_main row is a dead Telegram JID.
    setRegisteredGroup('msteams:a:owner', {
      name: 'Atlas',
      folder: 'atlas_teams',
      trigger: '@Atlas',
      added_at: '2024-01-02T00:00:00.000Z',
      requiresTrigger: false,
    });
    // Legacy pre-invariant row: seeded via the unchecked test helper because
    // setRegisteredGroup now rejects undeliverable-JID main promotion.
    setRegisteredGroup('tg:7322433447', {
      name: 'Telegram Main (dead)',
      folder: 'main',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    _setGroupIsMainUnchecked('tg:7322433447');

    _loadState(); // demotes the dead Telegram main
    ensureOwnerMainGroup('msteams:a:owner'); // next owner message

    const groups = getAllRegisteredGroups();
    expect(groups['msteams:a:owner'].isMain).toBe(true);
    // Existing registration is preserved — promotion must not rewrite the
    // folder (host-task policy is keyed by it) or other config.
    expect(groups['msteams:a:owner'].folder).toBe('atlas_teams');
    expect(groups['tg:7322433447'].isMain).toBeUndefined();
  });

  it('does NOT steal main while a live main exists elsewhere', () => {
    setRegisteredGroup('msteams:a:control', {
      name: 'Atlas',
      folder: 'atlas_main',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    setRegisteredGroup('msteams:a:owner-side-chat', {
      name: 'Side chat',
      folder: 'atlas_teams',
      trigger: '@Atlas',
      added_at: '2024-01-02T00:00:00.000Z',
    });

    _loadState();
    ensureOwnerMainGroup('msteams:a:owner-side-chat');

    const groups = getAllRegisteredGroups();
    expect(groups['msteams:a:owner-side-chat'].isMain).toBeUndefined();
    expect(groups['msteams:a:control'].isMain).toBe(true);
  });

  it('a dispatch: alias main does NOT block owner re-promotion', () => {
    // codex e6dde1a finding 2: "live main" must use the shared
    // knowably-undeliverable contract, not retired-only. An in-memory
    // dispatch: main row (legacy/hand-edited state that predates the
    // write-layer invariant) can no more deliver CEO alerts than a retired
    // tg: row — the owner's chat must still be promotable without waiting
    // for a restart.
    _setRegisteredGroups({
      'msteams:a:owner': {
        name: 'Atlas',
        folder: 'atlas_teams',
        trigger: '@Atlas',
        added_at: '2024-01-02T00:00:00.000Z',
        requiresTrigger: false,
      },
      'dispatch:atlas_gpg': {
        name: 'Bridge alias (stale main)',
        folder: 'atlas_gpg',
        trigger: '@Atlas',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    });

    ensureOwnerMainGroup('msteams:a:owner');

    expect(getAllRegisteredGroups()['msteams:a:owner'].isMain).toBe(true);
  });

  it('is a no-op for a chat that is already main', () => {
    setRegisteredGroup('msteams:a:owner', {
      name: 'Atlas',
      folder: 'atlas_teams',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    _loadState();
    ensureOwnerMainGroup('msteams:a:owner');

    const groups = getAllRegisteredGroups();
    expect(groups['msteams:a:owner'].isMain).toBe(true);
    expect(Object.values(groups).filter((g) => g.isMain)).toHaveLength(1);
  });
});
