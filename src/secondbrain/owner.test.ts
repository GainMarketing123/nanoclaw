import { describe, it, expect } from 'vitest';
import {
  isOwner,
  loadOwnerConfigFromEnv,
  OwnerConfig,
  SenderIdentity,
} from './owner.js';

describe('isOwner', () => {
  it('matches by aadObjectId', () => {
    const sender: SenderIdentity = { aadObjectId: 'owner-aad-1' };
    const owner: OwnerConfig = { aadObjectId: 'owner-aad-1' };
    expect(isOwner(sender, owner)).toBe(true);
  });

  it('matches by upn case-insensitively', () => {
    const sender: SenderIdentity = { upn: 'TLE@GainManagement.com' };
    const owner: OwnerConfig = { upn: 'tle@gainmanagement.com' };
    expect(isOwner(sender, owner)).toBe(true);
  });

  it('fails closed when NO owner is configured', () => {
    const sender: SenderIdentity = { aadObjectId: 'anyone', upn: 'a@b.com' };
    expect(isOwner(sender, {})).toBe(false);
  });

  it('rejects a wrong aadObjectId', () => {
    const sender: SenderIdentity = { aadObjectId: 'attacker-aad' };
    const owner: OwnerConfig = { aadObjectId: 'owner-aad-1' };
    expect(isOwner(sender, owner)).toBe(false);
  });

  it('rejects a sender with no identity at all', () => {
    const owner: OwnerConfig = { aadObjectId: 'owner-aad-1', upn: 'tle@x.com' };
    expect(isOwner({}, owner)).toBe(false);
  });

  it('rejects when owner.upn is set but the sender has no upn', () => {
    const sender: SenderIdentity = { aadObjectId: 'someone-else' };
    const owner: OwnerConfig = { upn: 'tle@gainmanagement.com' };
    expect(isOwner(sender, owner)).toBe(false);
  });
});

describe('loadOwnerConfigFromEnv', () => {
  it('reads and trims both fields', () => {
    expect(
      loadOwnerConfigFromEnv({
        ATLAS_OWNER_AAD_OBJECT_ID: '  aad-1  ',
        ATLAS_OWNER_UPN: '  tle@x.com  ',
      }),
    ).toEqual({ aadObjectId: 'aad-1', upn: 'tle@x.com' });
  });

  it('omits empty values', () => {
    expect(
      loadOwnerConfigFromEnv({
        ATLAS_OWNER_AAD_OBJECT_ID: '',
        ATLAS_OWNER_UPN: '   ',
      }),
    ).toEqual({});
  });

  it('returns {} when nothing is set', () => {
    expect(loadOwnerConfigFromEnv({})).toEqual({});
  });
});
