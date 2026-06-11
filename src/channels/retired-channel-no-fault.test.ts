import { describe, it, expect } from 'vitest';

import {
  findChannel,
  isRetiredChannelJid,
  RetiredChannelDropError,
} from '../router.js';
import { Channel } from '../types.js';

/**
 * Telegram is intentionally retired (CEO 2026-06-11; Teams is the primary
 * channel). Retired-channel group rows (e.g. `tg:7322433447`,
 * `tg:-5063551496`) still live in the DB, and IPC consumers — notably the
 * host-executor's auth-failure CEO alert — may still target one. The orchestrator
 * must treat "no channel owns this JID" as an EXPECTED, non-fault state, not a
 * delivery fault. Regression guard for the false
 * "No channel for JID: tg:…" alarm surfaced in
 * plans/gpg-chat-nonresponse-diagnosis-2026-06-11.md §2: the IPC-watcher send
 * callbacks now warn-and-drop for an unowned JID (src/index.ts `noChannel`)
 * instead of throwing.
 */
function fakeTeamsChannel(): Channel {
  return {
    name: 'teams',
    ownsJid: (jid: string) => jid.startsWith('msteams:'),
    isConnected: () => true,
    sendMessage: async () => {},
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as Channel;
}

describe('retired Telegram channel is not a fault', () => {
  const channels = [fakeTeamsChannel()];

  it('a tg: JID resolves to no owning channel (expected, not an error)', () => {
    // The live channel set is Teams-only; no channel owns a Telegram JID.
    expect(findChannel(channels, 'tg:7322433447')).toBeUndefined();
    expect(findChannel(channels, 'tg:-5063551496')).toBeUndefined();
  });

  it('the live Teams channel still owns its own JIDs', () => {
    // Removing the Telegram fault must NOT break live-channel resolution.
    expect(findChannel(channels, 'msteams:a:1BURQLVbTugEhlj-')?.name).toBe(
      'teams',
    );
  });

  it('an unknown/retired JID returning undefined is the no-op contract', () => {
    // src/index.ts IPC-watcher send callbacks rely on findChannel returning
    // undefined here and then warn-and-drop (Promise.resolve()) rather than
    // throw — a missing channel is best-effort no-op, not a thrown fault.
    const resolved = findChannel(channels, 'tg:7322433447');
    expect(resolved).toBeUndefined();
    // Contract: callers must NOT throw on this; they degrade gracefully.
    // (The throwing path was the false-alarm source we removed.)
  });

  // cross-review 4ce737e F1: the no-channel handler must DISCRIMINATE retired
  // channels from live-but-unmapped ones. Only retired JIDs are quietly
  // dropped; every other unowned JID must still surface as a fault so the IPC
  // watcher preserves the file to data/ipc/errors instead of silently losing a
  // live message + unlinking its document payload with a false "sent" log.
  describe('isRetiredChannelJid discriminates retired vs live-but-unmapped', () => {
    it('classifies retired Telegram JIDs as retired (quiet-drop allowed)', () => {
      expect(isRetiredChannelJid('tg:7322433447')).toBe(true);
      expect(isRetiredChannelJid('tg:-5063551496')).toBe(true);
    });

    it('does NOT classify live/unknown JIDs as retired (must still fault)', () => {
      // A live Teams JID, a WhatsApp JID, a bridge dispatch JID, and a
      // typo'd/unknown JID are all NOT retired — a no-channel result for any of
      // these is a genuine misroute, not an expected absence.
      expect(isRetiredChannelJid('msteams:a:1BURQLVbTugEhlj-')).toBe(false);
      expect(isRetiredChannelJid('12345678@g.us')).toBe(false);
      expect(isRetiredChannelJid('dispatch:atlas_gpg')).toBe(false);
      expect(isRetiredChannelJid('typo-unmapped-jid')).toBe(false);
    });
  });

  // cross-review F2: a retired-channel drop must be a TYPED signal, not a
  // resolved promise — otherwise the IPC watcher logs a false "sent" success
  // and unlinks the document payload for something intentionally dropped. The
  // typed error lets src/ipc.ts log "dropped" and clean up as handled (not
  // errored), while a NON-retired unowned JID throws a plain Error so the
  // watcher preserves the file to data/ipc/errors.
  describe('RetiredChannelDropError carries the JID and is distinguishable', () => {
    it('is an Error subclass carrying the dropped JID', () => {
      const err = new RetiredChannelDropError('tg:7322433447');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RetiredChannelDropError);
      expect(err.jid).toBe('tg:7322433447');
      expect(err.name).toBe('RetiredChannelDropError');
    });

    it('a plain Error (live-but-unmapped fault) is NOT a RetiredChannelDropError', () => {
      // The watcher branches on `instanceof RetiredChannelDropError`; a generic
      // "No channel for JID" Error must fall through to the error-dir path.
      const plain = new Error('No channel for JID: typo-unmapped-jid');
      expect(plain instanceof RetiredChannelDropError).toBe(false);
    });
  });
});
