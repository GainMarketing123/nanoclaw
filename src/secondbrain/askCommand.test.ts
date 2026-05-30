import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleOwnerAsk } from './askCommand.js';
import type { SecondBrainClient, AskResult, EntityInfo } from './client.js';
import type { OwnerConfig, SenderIdentity } from './owner.js';

const OWNER: OwnerConfig = { aadObjectId: 'owner-aad-1' };
const OWNER_SENDER: SenderIdentity = { aadObjectId: 'owner-aad-1' };
const NON_OWNER: SenderIdentity = { aadObjectId: 'attacker-aad' };

const ENTITIES: EntityInfo[] = [
  { id: 'e-gpg', slug: 'gpg', display_name: 'GPG' },
  { id: 'e-ws', slug: 'wisestream', display_name: 'WiseStream' },
  { id: 'e-personal', slug: 'personal', display_name: null },
];

function answered(answer: string): AskResult {
  return {
    answer,
    provenance: [
      {
        raw_event_id: 'abcdef1234567890',
        source: 'email',
        memory_item_ids: ['m1'],
        score: 0.9,
        cached: false,
      },
    ],
    degraded: false,
  };
}

const EMPTY: AskResult = { answer: '', provenance: [], degraded: false };
const DEGRADED: AskResult = { answer: '', provenance: [], degraded: true };

function fakeClient(opts: {
  entities?: EntityInfo[];
  ask?: (entityId: string) => AskResult;
}) {
  const listEntities = vi.fn(async () => opts.entities ?? ENTITIES);
  const ask = vi.fn(async (entityId: string) =>
    opts.ask ? opts.ask(entityId) : EMPTY,
  );
  return {
    client: { listEntities, ask } as unknown as SecondBrainClient,
    listEntities,
    ask,
  };
}

describe('handleOwnerAsk', () => {
  it('hard-refuses a non-owner and never touches the brain', async () => {
    const { client, listEntities, ask } = fakeClient({});
    const out = await handleOwnerAsk(client, NON_OWNER, OWNER, 'secrets?');

    expect(out.text).toContain("CEO's private Atlas");
    expect(listEntities).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('fails closed (refuses) when no owner is configured', async () => {
    const { client, listEntities } = fakeClient({});
    const out = await handleOwnerAsk(client, OWNER_SENDER, {}, 'hi');

    expect(out.text).toContain("CEO's private Atlas");
    expect(listEntities).not.toHaveBeenCalled();
  });

  it('returns degraded when every entity is degraded', async () => {
    const { client } = fakeClient({ ask: () => DEGRADED });
    const out = await handleOwnerAsk(client, OWNER_SENDER, OWNER, 'hi');

    expect(out.text).toContain('catching up');
  });

  it('returns degraded when there are no entities', async () => {
    const { client, ask } = fakeClient({ entities: [] });
    const out = await handleOwnerAsk(client, OWNER_SENDER, OWNER, 'hi');

    expect(out.text).toContain('catching up');
    expect(ask).not.toHaveBeenCalled();
  });

  it('builds a section only for the entity that answered (mixed)', async () => {
    const { client, ask } = fakeClient({
      ask: (id) =>
        id === 'e-gpg' ? answered('The deal closed Tuesday.') : EMPTY,
    });
    const out = await handleOwnerAsk(client, OWNER_SENDER, OWNER, 'when?');

    expect(ask).toHaveBeenCalledTimes(3);
    expect(out.text).toContain('GPG');
    expect(out.text).toContain('The deal closed Tuesday.');
    // The non-answering entities are NOT labelled in the merged output.
    expect(out.text).not.toContain('WiseStream');
    expect(out.text).not.toContain('personal');
    expect(JSON.stringify(out.card)).toContain('The deal closed Tuesday.');
  });

  it('skips the "No memory matched." sentinel as empty', async () => {
    const { client } = fakeClient({
      ask: () => answered('No memory matched.'),
    });
    const out = await handleOwnerAsk(client, OWNER_SENDER, OWNER, 'hi');

    expect(out.text).toBe('No memory matched across your spaces.');
  });

  it('returns the no-memory copy when all entities answer empty', async () => {
    const { client } = fakeClient({ ask: () => EMPTY });
    const out = await handleOwnerAsk(client, OWNER_SENDER, OWNER, 'hi');

    expect(out.text).toBe('No memory matched across your spaces.');
  });

  it('merges multiple answering entities, each labelled', async () => {
    const { client } = fakeClient({
      ask: (id) =>
        id === 'e-gpg'
          ? answered('GPG answer.')
          : id === 'e-personal'
            ? answered('Personal answer.')
            : EMPTY,
    });
    const out = await handleOwnerAsk(client, OWNER_SENDER, OWNER, 'hi');

    expect(out.text).toContain('GPG');
    expect(out.text).toContain('GPG answer.');
    // display_name null ⇒ falls back to the slug label.
    expect(out.text).toContain('personal');
    expect(out.text).toContain('Personal answer.');
  });
});
