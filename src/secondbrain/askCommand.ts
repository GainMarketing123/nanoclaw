/**
 * Transport-agnostic "ask the brain" handler.
 *
 * Encapsulates the cross-entity guardrail so any channel (Teams today,
 * others later) gets identical safe-refusal behaviour. The order of checks
 * is load-bearing: we NEVER call the brain until we've positively resolved
 * which business this conversation belongs to.
 */
import { SecondBrainClient } from './client.js';
import {
  TeamsContext,
  EntityMap,
  resolveEntitySlug,
  isAllowedTenant,
} from './entityMap.js';
import {
  renderAnswerText,
  renderAnswerCard,
  renderDegradedText,
  renderDegradedCard,
} from './cards.js';

/** Refusal shown when we can't tell which business owns this conversation. */
const UNMAPPED_REFUSAL =
  "I can't tell which business this chat belongs to — ask your admin to map this conversation.";

/** Refusal shown when the activity fails the tenant guard. */
const TENANT_REFUSAL =
  "I can't answer here — this chat isn't on an approved tenant.";

function refusal(text: string): { text: string; card: object } {
  return {
    text,
    card: {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [{ type: 'TextBlock', text, wrap: true }],
    },
  };
}

/**
 * Resolve + guard + ask. Returns rendered text and an Adaptive Card.
 *
 * Refuses (without ever touching the brain) when:
 *   - the tenant guard fails, or
 *   - the conversation isn't mapped to a business, or
 *   - the resolved slug has no entity id.
 */
export async function handleAsk(
  client: SecondBrainClient,
  entitySlugToId: (slug: string) => string | null,
  ctx: TeamsContext,
  entityMap: EntityMap,
  allowedTenantId: string | undefined,
  question: string,
): Promise<{ text: string; card: object }> {
  if (!isAllowedTenant(ctx, allowedTenantId)) {
    return refusal(TENANT_REFUSAL);
  }

  const slug = resolveEntitySlug(ctx, entityMap);
  if (slug === null) {
    return refusal(UNMAPPED_REFUSAL);
  }

  const entityId = entitySlugToId(slug);
  if (entityId === null) {
    return refusal(UNMAPPED_REFUSAL);
  }

  const result = await client.ask(entityId, question);
  if (result.degraded) {
    return { text: renderDegradedText(), card: renderDegradedCard() };
  }

  return {
    text: renderAnswerText(result.answer, result.provenance),
    card: renderAnswerCard(result.answer, result.provenance),
  };
}
