import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleAsk } from './askCommand.js';
import type { SecondBrainClient, AskResult } from './client.js';
import { EntityMap, TeamsContext } from './entityMap.js';

const MAP: EntityMap = { '19:abc@thread.v2': 'gpg' };
const slugToId = (slug: string) => (slug === 'gpg' ? 'entity-gpg' : null);

function fakeClient(askImpl: () => Promise<AskResult>) {
  const ask = vi.fn(askImpl);
  return { client: { ask } as unknown as SecondBrainClient, ask };
}

describe('handleAsk', () => {
  it('refuses an unmapped conversation and never calls the brain', async () => {
    const { client, ask } = fakeClient(async () => ({
      answer: '',
      provenance: [],
      degraded: false,
    }));
    const ctx: TeamsContext = { conversationId: '19:unknown@thread.v2' };

    const out = await handleAsk(client, slugToId, ctx, MAP, undefined, 'hi');

    expect(out.text).toContain("can't tell which business");
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses on a wrong tenant and never calls the brain', async () => {
    const { client, ask } = fakeClient(async () => ({
      answer: '',
      provenance: [],
      degraded: false,
    }));
    const ctx: TeamsContext = {
      conversationId: '19:abc@thread.v2',
      tenantId: 'evil-tenant',
    };

    const out = await handleAsk(client, slugToId, ctx, MAP, 'good-tenant', 'hi');

    expect(out.text).toContain('approved tenant');
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses when the slug has no entity id', async () => {
    const { client, ask } = fakeClient(async () => ({
      answer: '',
      provenance: [],
      degraded: false,
    }));
    const ctx: TeamsContext = { conversationId: '19:abc@thread.v2' };
    const noId = () => null;

    const out = await handleAsk(client, noId, ctx, MAP, undefined, 'hi');

    expect(out.text).toContain("can't tell which business");
    expect(ask).not.toHaveBeenCalled();
  });

  it('renders the degraded fallback when the brain is degraded', async () => {
    const { client, ask } = fakeClient(async () => ({
      answer: '',
      provenance: [],
      degraded: true,
    }));
    const ctx: TeamsContext = { conversationId: '19:abc@thread.v2' };

    const out = await handleAsk(client, slugToId, ctx, MAP, undefined, 'hi');

    expect(out.text).toContain('catching up');
    expect(ask).toHaveBeenCalledWith('entity-gpg', 'hi');
  });

  it('renders the answer with its source on success', async () => {
    const { client, ask } = fakeClient(async () => ({
      answer: 'The deal closed Tuesday.',
      provenance: [
        {
          raw_event_id: 'abcdef1234',
          source: 'email',
          memory_item_ids: ['m1'],
          score: 0.9,
          cached: false,
        },
      ],
      degraded: false,
    }));
    const ctx: TeamsContext = { conversationId: '19:abc@thread.v2' };

    const out = await handleAsk(
      client,
      slugToId,
      ctx,
      MAP,
      undefined,
      'when did it close?',
    );

    expect(out.text).toContain('The deal closed Tuesday.');
    expect(out.text).toContain('email');
    expect(ask).toHaveBeenCalledWith('entity-gpg', 'when did it close?');
  });
});
