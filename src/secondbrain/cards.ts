/**
 * Pure render helpers for Second-Brain answers in Teams.
 *
 * No SDK dependency — these produce plain text and Adaptive Card JSON
 * (v1.4) so they're trivially unit-testable and reusable from any transport.
 */
import { AskProvenance } from './client.js';

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

/**
 * Render an answer plus a compact "Sources:" footer as plain text.
 * When there is no provenance, just the answer is returned.
 */
export function renderAnswerText(
  answer: string,
  provenance: AskProvenance[],
): string {
  if (!provenance.length) return answer;
  const lines = provenance.map((p) => `- ${provenanceLine(p)}`);
  return `${answer}\n\nSources:\n${lines.join('\n')}`;
}

/**
 * Render the answer as an Adaptive Card v1.4 with the answer text and a
 * FactSet of sources.
 */
export function renderAnswerCard(
  answer: string,
  provenance: AskProvenance[],
): object {
  const body: object[] = [
    {
      type: 'TextBlock',
      text: answer,
      wrap: true,
    },
  ];

  if (provenance.length) {
    body.push({
      type: 'TextBlock',
      text: 'Sources',
      weight: 'Bolder',
      spacing: 'Medium',
      separator: true,
    });
    body.push({
      type: 'FactSet',
      facts: provenance.map((p) => ({
        title: p.source ?? 'unknown',
        value: `${shortId(p.raw_event_id)}${p.cached ? ' (cached)' : ''}`,
      })),
    });
  }

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
