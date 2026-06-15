import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { parseLoomQuestion } from './client.js';

describe('parseLoomQuestion', () => {
  it('extracts the question after a "loom" prefix', () => {
    expect(parseLoomQuestion('loom how do I write a hook?')).toBe(
      'how do I write a hook?',
    );
  });

  it('strips a colon and is case-insensitive', () => {
    expect(parseLoomQuestion('Loom: pricing strategy')).toBe(
      'pricing strategy',
    );
  });

  it('returns an empty string when the message is just "loom"', () => {
    expect(parseLoomQuestion('loom')).toBe('');
  });

  it('returns null when "loom" is not the leading word', () => {
    expect(parseLoomQuestion('I loom over the code')).toBeNull();
  });

  it('trims surrounding and inner whitespace', () => {
    expect(parseLoomQuestion('  loom   spaced  ')).toBe('spaced');
  });

  it('extracts the question after a "course" prefix', () => {
    expect(parseLoomQuestion('course how do I write a hook?')).toBe(
      'how do I write a hook?',
    );
  });

  it('extracts the question after a "courses" prefix', () => {
    expect(parseLoomQuestion('courses how do I write a hook?')).toBe(
      'how do I write a hook?',
    );
  });

  it('strips a colon after "courses" and is case-insensitive', () => {
    expect(parseLoomQuestion('Courses: pricing')).toBe('pricing');
  });

  it('returns an empty string when the message is just "course"', () => {
    expect(parseLoomQuestion('course')).toBe('');
  });

  it('returns an empty string when the message is just "courses"', () => {
    expect(parseLoomQuestion('courses')).toBe('');
  });

  it('returns null when "course" is not the leading word', () => {
    expect(parseLoomQuestion('I took a course')).toBeNull();
  });

  it('returns null when "courses" is not the leading word', () => {
    expect(parseLoomQuestion('the courses are great')).toBeNull();
  });

  it('does not treat "coursework" as a course trigger', () => {
    expect(parseLoomQuestion('coursework is due')).toBeNull();
  });
});
