/**
 * Pure render helpers for Second-Brain answers in Teams.
 *
 * No SDK dependency — these produce plain text and Adaptive Card JSON
 * (v1.4) so they're trivially unit-testable and reusable from any transport.
 *
 * The owner all-access model returns ONE answer that merges sections from
 * every entity the owner spans (businesses + personal). Each section carries
 * its entity label so the owner can see which space each answer came from.
 */
import { AskProvenance } from './client.js';

/**
 * One entity's contribution to the merged owner answer.
 *
 * Defined HERE (not in askCommand.ts) to avoid a circular import: askCommand
 * imports these renderers, and the renderers need the section shape. askCommand
 * re-imports this type from './cards.js'.
 */
export interface OwnerAnswerSection {
  entitySlug: string;
  entityName: string;
  answer: string;
  provenance: AskProvenance[];
}

/** Fallback copy shown when the brain is degraded / catching up. */
const DEGRADED_COPY = 'Memory is catching up — try again in a moment.';

/** First 8 chars of a raw_event_id, for a compact human-readable reference. */
function shortId(rawEventId: string): string {
  return (rawEventId || '').slice(0, 8);
}

/** A single "source - id (cached)" footer line for a provenance entry. */
function provenanceLine(p: AskProvenance): string {
  const source = p.source ?? 'unknown';
  const parts = [`${source} ${shortId(p.raw_event_id)}`];
  if (p.cached) parts.push('(cached)');
  return parts.join(' ');
}

/** Render one section as plain text: header, answer, then a Sources footer. */
function sectionText(section: OwnerAnswerSection): string {
  const lines = [`=== ${section.entityName} ===`, section.answer];
  if (section.provenance.length) {
    lines.push('Sources:');
    for (const p of section.provenance) lines.push(`- ${provenanceLine(p)}`);
  }
  return lines.join('\n');
}

/**
 * Render the merged owner answer as plain text: one labelled block per entity,
 * sections separated by a blank line.
 */
export function renderOwnerAnswerText(sections: OwnerAnswerSection[]): string {
  return sections.map(sectionText).join('\n\n');
}

/**
 * Render the merged owner answer as a single Adaptive Card v1.4 with one
 * Container per entity section (bold entity name, the answer, the sources).
 */
export function renderOwnerAnswerCard(
  sections: OwnerAnswerSection[],
): object {
  const body = sections.map((section) => {
    const items: object[] = [
      {
        type: 'TextBlock',
        text: section.entityName,
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: section.answer,
        wrap: true,
      },
    ];

    if (section.provenance.length) {
      items.push({
        type: 'TextBlock',
        text: 'Sources',
        weight: 'Bolder',
        spacing: 'Medium',
        separator: true,
      });
      items.push({
        type: 'FactSet',
        facts: section.provenance.map((p) => ({
          title: p.source ?? 'unknown',
          value: `${shortId(p.raw_event_id)}${p.cached ? ' (cached)' : ''}`,
        })),
      });
    }

    return {
      type: 'Container',
      separator: true,
      spacing: 'Medium',
      items,
    };
  });

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body,
  };
}

/** Plain-text degraded fallback. */
export function renderDegradedText(): string {
  return DEGRADED_COPY;
}

/** Adaptive Card degraded fallback. */
export function renderDegradedCard(): object {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: DEGRADED_COPY,
        wrap: true,
      },
    ],
  };
}
