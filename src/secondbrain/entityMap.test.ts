import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  resolveEntitySlug,
  isAllowedTenant,
  loadEntityMapFromEnv,
  TeamsContext,
  EntityMap,
} from './entityMap.js';

describe('resolveEntitySlug', () => {
  const map: EntityMap = {
    '19:abc@thread.v2': 'gpg',
    '19:def@thread.v2': 'wisestream',
  };

  it('returns the slug for a mapped conversation', () => {
    const ctx: TeamsContext = { conversationId: '19:abc@thread.v2' };
    expect(resolveEntitySlug(ctx, map)).toBe('gpg');
  });

  it('returns null for an unmapped conversation (never a default)', () => {
    const ctx: TeamsContext = { conversationId: '19:unknown@thread.v2' };
    const result = resolveEntitySlug(ctx, map);
    expect(result).toBeNull();
    // Explicitly assert it did NOT fall back to any known slug.
    expect(result).not.toBe('gpg');
    expect(result).not.toBe('wisestream');
  });

  it('returns null against an empty map', () => {
    const ctx: TeamsContext = { conversationId: '19:abc@thread.v2' };
    expect(resolveEntitySlug(ctx, {})).toBeNull();
  });
});

describe('isAllowedTenant', () => {
  it('allows when the tenant matches', () => {
    const ctx: TeamsContext = { conversationId: 'c', tenantId: 'tenant-1' };
    expect(isAllowedTenant(ctx, 'tenant-1')).toBe(true);
  });

  it('rejects when the tenant differs', () => {
    const ctx: TeamsContext = { conversationId: 'c', tenantId: 'other' };
    expect(isAllowedTenant(ctx, 'tenant-1')).toBe(false);
  });

  it('rejects when the activity has no tenant but one is required', () => {
    const ctx: TeamsContext = { conversationId: 'c' };
    expect(isAllowedTenant(ctx, 'tenant-1')).toBe(false);
  });

  it('allows any tenant when none is configured (dev)', () => {
    const ctx: TeamsContext = { conversationId: 'c', tenantId: 'whatever' };
    expect(isAllowedTenant(ctx, undefined)).toBe(true);
  });
});

describe('loadEntityMapFromEnv', () => {
  it('parses a valid JSON object', () => {
    const raw = '{"19:abc@thread.v2":"gpg"}';
    expect(loadEntityMapFromEnv(raw)).toEqual({ '19:abc@thread.v2': 'gpg' });
  });

  it('returns {} for undefined', () => {
    expect(loadEntityMapFromEnv(undefined)).toEqual({});
  });

  it('returns {} for invalid JSON', () => {
    expect(loadEntityMapFromEnv('{not valid json')).toEqual({});
  });

  it('returns {} for non-object JSON (e.g. an array)', () => {
    expect(loadEntityMapFromEnv('["gpg"]')).toEqual({});
  });
});
