import { describe, expect, it } from 'vitest';

import {
  computeVerifyStatus,
  teamsGateSatisfied,
  VerifyStatusInputs,
} from './verify.js';

/**
 * Success-gate tests for setup verification (feat-verify-ts-teams-gate).
 *
 * Teams is the primary CEO command channel; verify must not declare success
 * for an install where some other channel is configured but Teams is not —
 * that install cannot deliver owner commands, mission approvals, or
 * escalation alerts to the CEO.
 */

const greenInputs = (): VerifyStatusInputs => ({
  service: 'running',
  credentials: 'configured',
  channelAuth: { teams: 'configured' },
  registeredGroups: 2,
});

describe('teamsGateSatisfied', () => {
  it('passes only when teams reports configured', () => {
    expect(teamsGateSatisfied({ teams: 'configured' })).toBe(true);
    expect(teamsGateSatisfied({})).toBe(false);
    expect(teamsGateSatisfied({ whatsapp: 'authenticated' })).toBe(false);
    // Defensive: any non-'configured' marker fails the gate.
    expect(teamsGateSatisfied({ teams: 'missing' })).toBe(false);
  });
});

describe('computeVerifyStatus', () => {
  it('reports success when service, credentials, Teams, and groups are all green', () => {
    expect(computeVerifyStatus(greenInputs())).toBe('success');
  });

  it('fails when Teams is not configured even though other channels are', () => {
    // The pre-gate behavior: anyChannelConfigured let a WhatsApp-only or
    // Discord-only install verify green while the CEO channel was dead.
    expect(
      computeVerifyStatus({
        ...greenInputs(),
        channelAuth: { whatsapp: 'authenticated', discord: 'configured' },
      }),
    ).toBe('failed');
  });

  it('fails when no channel at all is configured', () => {
    expect(
      computeVerifyStatus({ ...greenInputs(), channelAuth: {} }),
    ).toBe('failed');
  });

  it('still succeeds when extra channels are configured alongside Teams', () => {
    expect(
      computeVerifyStatus({
        ...greenInputs(),
        channelAuth: {
          teams: 'configured',
          whatsapp: 'authenticated',
          slack: 'configured',
        },
      }),
    ).toBe('success');
  });

  it('fails when the service is not running', () => {
    expect(
      computeVerifyStatus({ ...greenInputs(), service: 'stopped' }),
    ).toBe('failed');
  });

  it('fails when credentials are missing', () => {
    expect(
      computeVerifyStatus({ ...greenInputs(), credentials: 'missing' }),
    ).toBe('failed');
  });

  it('fails when no groups are registered', () => {
    expect(
      computeVerifyStatus({ ...greenInputs(), registeredGroups: 0 }),
    ).toBe('failed');
  });
});
