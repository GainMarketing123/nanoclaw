import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseAskQuestion,
  senderIdentityFromMessage,
  maybeHandleAskMessage,
  ASK_USAGE_HINT,
  ASK_PROGRESS_PING,
} from './askDispatch.js';
import type { SecondBrainClient, AskResult, EntityInfo } from './client.js';
import type { OwnerConfig, SenderIdentity } from './owner.js';
import type { NewMessage } from '../types.js';

const OWNER: OwnerConfig = { aadObjectId: 'owner-aad-1' };
const OWNER_SENDER: SenderIdentity = { aadObjectId: 'owner-aad-1' };
const NON_OWNER: SenderIdentity = { aadObjectId: 'attacker-aad' };

const ENTITIES: EntityInfo[] = [
  { id: 'e-gpg', slug: 'gpg', display_name: 'GPG' },
];

const ANSWERED: AskResult = {
  answer: 'The deal closed Tuesday.',
  provenance: [],
  degraded: false,
};
const DEGRADED: AskResult = { answer: '', provenance: [], degraded: true };

function fakeClient(opts: {
  entities?: EntityInfo[];
  ask?: () => AskResult;
}) {
  const listEntities = vi.fn(async () => opts.entities ?? ENTITIES);
  const ask = vi.fn(async () => (opts.ask ? opts.ask() : ANSWERED));
  return {
    client: { listEntities, ask } as unknown as SecondBrainClient,
    listEntities,
    ask,
  };
}

function sendCollector() {
  const sent: string[] = [];
  const send = vi.fn(async (text: string) => {
    sent.push(text);
  });
  return { sent, send };
}

describe('parseAskQuestion', () => {
  it('extracts the question from "/ask <question>"', () => {
    expect(parseAskQuestion('/ask when did the deal close?')).toBe(
      'when did the deal close?',
    );
  });

  it('is case-insensitive and tolerates separators + whitespace', () => {
    expect(parseAskQuestion('  /Ask:   what now  ')).toBe('what now');
  });

  it('returns "" for a bare "/ask"', () => {
    expect(parseAskQuestion('/ask')).toBe('');
    expect(parseAskQuestion('  /ask  ')).toBe('');
  });

  it('returns null for non-ask text (incl. prefix-collisions)', () => {
    expect(parseAskQuestion('hello')).toBeNull();
    expect(parseAskQuestion('/askance what')).toBeNull();
    expect(parseAskQuestion('ask without slash')).toBeNull();
    expect(parseAskQuestion('/status')).toBeNull();
  });
});

describe('senderIdentityFromMessage', () => {
  const base: NewMessage = {
    id: 'm1',
    chat_jid: 'msteams:19:abc',
    sender: '29:user',
    sender_name: 'CEO',
    content: '/ask hi',
    timestamp: '2026-06-09T00:00:00.000Z',
  };

  it('lifts the verified identity fields when present', () => {
    expect(
      senderIdentityFromMessage({
        ...base,
        sender_aad_object_id: 'owner-aad-1',
        sender_upn: 'ceo@example.com',
      }),
    ).toEqual({
      aadObjectId: 'owner-aad-1',
      upn: 'ceo@example.com',
      name: 'CEO',
    });
  });

  it('yields an identity that can NEVER pass isOwner when the channel did not verify (fail-closed)', () => {
    const identity = senderIdentityFromMessage(base);
    expect(identity.aadObjectId).toBeUndefined();
    expect(identity.upn).toBeUndefined();
    expect(identity.name).toBe('CEO');
  });
});

describe('maybeHandleAskMessage', () => {
  it('returns false and sends nothing for a non-ask message', async () => {
    const { client, listEntities } = fakeClient({});
    const { sent, send } = sendCollector();

    const handled = await maybeHandleAskMessage({
      text: 'just chatting',
      sender: OWNER_SENDER,
      owner: OWNER,
      client,
      send,
    });

    expect(handled).toBe(false);
    expect(sent).toEqual([]);
    expect(listEntities).not.toHaveBeenCalled();
  });

  it('sends the usage hint for a bare "/ask" without touching the brain', async () => {
    const { client, listEntities } = fakeClient({});
    const { sent, send } = sendCollector();

    const handled = await maybeHandleAskMessage({
      text: '/ask',
      sender: OWNER_SENDER,
      owner: OWNER,
      client,
      send,
    });

    expect(handled).toBe(true);
    expect(sent).toEqual([ASK_USAGE_HINT]);
    expect(listEntities).not.toHaveBeenCalled();
  });

  it('owner asks → progress ping then the merged answer', async () => {
    const { client } = fakeClient({});
    const { sent, send } = sendCollector();

    const handled = await maybeHandleAskMessage({
      text: '/ask when did the deal close?',
      sender: OWNER_SENDER,
      owner: OWNER,
      client,
      send,
    });

    expect(handled).toBe(true);
    expect(sent[0]).toBe(ASK_PROGRESS_PING);
    expect(sent[1]).toContain('GPG');
    expect(sent[1]).toContain('The deal closed Tuesday.');
  });

  it('non-owner asks → refusal ONLY (no progress ping, brain never touched)', async () => {
    const { client, listEntities, ask } = fakeClient({});
    const { sent, send } = sendCollector();

    const handled = await maybeHandleAskMessage({
      text: '/ask secrets?',
      sender: NON_OWNER,
      owner: OWNER,
      client,
      send,
    });

    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("CEO's private Atlas");
    expect(listEntities).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('fails closed when the message carries no verified identity', async () => {
    const { client, listEntities } = fakeClient({});
    const { sent, send } = sendCollector();

    await maybeHandleAskMessage({
      text: '/ask secrets?',
      // What senderIdentityFromMessage yields on an unverified transport.
      sender: { name: 'CEO' },
      owner: OWNER,
      client,
      send,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("CEO's private Atlas");
    expect(listEntities).not.toHaveBeenCalled();
  });

  it('degraded brain → friendly catching-up reply', async () => {
    const { client } = fakeClient({ ask: () => DEGRADED });
    const { sent, send } = sendCollector();

    await maybeHandleAskMessage({
      text: '/ask anything there?',
      sender: OWNER_SENDER,
      owner: OWNER,
      client,
      send,
    });

    expect(sent[0]).toBe(ASK_PROGRESS_PING);
    expect(sent[1]).toContain('catching up');
  });

  it('an unexpected throw still produces a friendly reply (never silence) and reports via onError', async () => {
    const boom = new Error('boom');
    const client = {
      listEntities: vi.fn(async () => {
        throw boom;
      }),
      ask: vi.fn(),
    } as unknown as SecondBrainClient;
    const { sent, send } = sendCollector();
    const onError = vi.fn();

    const handled = await maybeHandleAskMessage({
      text: '/ask hello?',
      sender: OWNER_SENDER,
      owner: OWNER,
      client,
      send,
      onError,
    });

    expect(handled).toBe(true);
    expect(sent[0]).toBe(ASK_PROGRESS_PING);
    expect(sent[1]).toContain('catching up');
    expect(onError).toHaveBeenCalledWith(boom);
  });
});
