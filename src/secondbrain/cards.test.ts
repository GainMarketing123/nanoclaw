import { describe, it, expect } from 'vitest';
import {
  renderAnswerText,
  renderAnswerCard,
  renderDegradedText,
  renderDegradedCard,
} from './cards.js';
import { AskProvenance } from './client.js';

const provenance: AskProvenance[] = [
  {
    raw_event_id: 'abcdef1234567890',
    source: 'email',
    memory_item_ids: ['m1'],
    score: 0.9,
    cached: true,
  },
];

describe('renderAnswerText', () => {
  it('includes the answer and a provenance source', () => {
    const text = renderAnswerText('The deal closed Tuesday.', provenance);
    expect(text).toContain('The deal closed Tuesday.');
    expect(text).toContain('Sources:');
    expect(text).toContain('email');
    expect(text).toContain('abcdef12'); // short raw_event_id
    expect(text).toContain('(cached)');
  });

  it('returns just the answer when there is no provenance', () => {
    expect(renderAnswerText('No sources.', [])).toBe('No sources.');
  });
});

describe('renderAnswerCard', () => {
  it('is an Adaptive Card v1.4 with the answer and a source fact', () => {
    const card = renderAnswerCard('The deal closed Tuesday.', provenance) as any;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.4');
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('The deal closed Tuesday.');
    expect(serialized).toContain('email');
    expect(serialized).toContain('abcdef12');
  });
});

describe('degraded renderers', () => {
  it('text includes the catching-up fallback copy', () => {
    expect(renderDegradedText()).toContain('catching up');
  });

  it('card includes the catching-up fallback copy', () => {
    const card = renderDegradedCard() as any;
    expect(card.type).toBe('AdaptiveCard');
    expect(JSON.stringify(card)).toContain('catching up');
  });
});
