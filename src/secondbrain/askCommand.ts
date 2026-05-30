/**
 * Transport-agnostic "ask the brain" handler for the OWNER all-access model.
 *
 * This bot is the CEO's private Atlas. The owner gate (isOwner) is the ONLY
 * thing protecting every business's data from a non-owner, so it is checked
 * FIRST and fails closed: a non-owner is hard-refused and the brain is never
 * touched. For the owner, we fan out across EVERY entity (the businesses + a
 * personal space) and merge the non-empty answers into one labelled response.
 */
import { SecondBrainClient, AskProvenance, EntityInfo } from './client.js';
import { isOwner, OwnerConfig, SenderIdentity } from './owner.js';
import {
  OwnerAnswerSection,
  renderOwnerAnswerText,
  renderOwnerAnswerCard,
  renderDegradedText,
  renderDegradedCard,
} from './cards.js';

// Re-export so callers can import the section shape from here too if they wish.
export type { OwnerAnswerSection };
export type { AskProvenance, EntityInfo };

/** Hard refusal shown to anyone who is not the configured owner. */
const NON_OWNER_REFUSAL =
  "This is the CEO's private Atlas. It isn't available to other accounts.";

/** Shown when the owner asks but no entity had anything to say. */
const NO_MEMORY_COPY = 'No memory matched across your spaces.';

/** The brain's "no hit" answer sentinel — skipped when building sections. */
const NO_MEMORY_ANSWER = 'No memory matched.';

function simpleCard(text: string): object {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [{ type: 'TextBlock', text, wrap: true }],
  };
}

/**
 * Owner gate + all-entity fan-out. Returns rendered text and an Adaptive Card.
 *
 * Order is load-bearing:
 *   1. Non-owner ⇒ hard refusal, brain NEVER touched.
 *   2. No entities ⇒ degraded.
 *   3. Fan out across all entities.
 *   4. Every result degraded ⇒ degraded.
 *   5. Build sections from non-empty answers.
 *   6. No non-empty sections ⇒ "no memory" copy.
 *   7. Otherwise merge into one labelled answer.
 */
export async function handleOwnerAsk(
  client: SecondBrainClient,
  sender: SenderIdentity,
  owner: OwnerConfig,
  question: string,
): Promise<{ text: string; card: object }> {
  // 1. Owner gate — fail-closed, brain never touched for a non-owner.
  if (!isOwner(sender, owner)) {
    return { text: NON_OWNER_REFUSAL, card: simpleCard(NON_OWNER_REFUSAL) };
  }

  // 2. Resolve every entity the owner spans.
  const entities = await client.listEntities();
  if (entities.length === 0) {
    return { text: renderDegradedText(), card: renderDegradedCard() };
  }

  // 3. Fan out across all entities in parallel.
  const results = await Promise.all(
    entities.map(async (e: EntityInfo) => ({
      entity: e,
      result: await client.ask(e.id, question),
    })),
  );

  // 4. If EVERY entity degraded, the brain is catching up.
  if (results.every((r) => r.result.degraded)) {
    return { text: renderDegradedText(), card: renderDegradedCard() };
  }

  // 5. Build sections from entities with a real answer (skip empty / no-hit).
  const sections: OwnerAnswerSection[] = results
    .filter((r) => {
      const a = r.result.answer.trim();
      return a.length > 0 && a !== NO_MEMORY_ANSWER;
    })
    .map((r) => ({
      entitySlug: r.entity.slug,
      entityName: r.entity.display_name ?? r.entity.slug,
      answer: r.result.answer,
      provenance: r.result.provenance,
    }));

  // 6. Nothing matched anywhere.
  if (sections.length === 0) {
    return { text: NO_MEMORY_COPY, card: simpleCard(NO_MEMORY_COPY) };
  }

  // 7. Merge into one labelled answer.
  return {
    text: renderOwnerAnswerText(sections),
    card: renderOwnerAnswerCard(sections),
  };
}
