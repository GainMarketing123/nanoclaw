import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
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
import { selectLiveMainJid } from './router.js';

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

  it('falls back to the first live candidate when none has folder "main"', () => {
    expect(
      selectLiveMainJid([
        { jid: 'msteams:a:first', folder: 'atlas_teams' },
        { jid: 'dc:123', folder: 'discord_general' },
      ]),
    ).toBe('msteams:a:first');
  });

  it('returns undefined for an empty candidate list', () => {
    expect(selectLiveMainJid([])).toBe(undefined);
  });
});

// --- loadState single-live-main normalization ---

describe('loadState single-live-main normalization', () => {
  it('durably demotes a sole retired-channel main (the 2026-06-11 VPS state)', () => {
    // A legacy Telegram main row survives the Teams migration as the only
    // is_main=1 row. Every DB-reading alert path would mis-route to it.
    setRegisteredGroup('tg:7322433447', {
      name: 'Telegram Main (dead)',
      folder: 'main',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

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
    setRegisteredGroup('tg:7322433447', {
      name: 'Telegram Main (dead)',
      folder: 'main',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

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
    expect(
      Object.values(groups).filter((g) => g.isMain),
    ).toHaveLength(1);
  });
});
