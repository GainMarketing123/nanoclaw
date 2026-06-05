/**
 * End-to-end proof of the Teams Adaptive Card Action.Submit click-back
 * (migration spec §2.4 / §2.5): a button tap is translated into a text command
 * and routed through the SAME `handleCommand` path the typed commands use —
 * one authorization gate, one code path. This test ties the two halves
 * together:
 *
 *   1. `callbackDataToCommand` (channels/teams.ts) turns the card payload
 *      `mission:approve:<id>` into the command string `/mission approve <id>`.
 *   2. The real `handleCommand` (commands.ts) dispatches that string to
 *      `missionApprove`, which flips the mission's SQLite status to 'approved'.
 *
 * The bridge POST that `missionApprove` fires is best-effort/async and tolerates
 * a down bridge (errors are logged, not thrown), so no bridge needs to be live:
 * the status flip is synchronous and is the observable, authoritative effect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { callbackDataToCommand } from './teams.js';
import { handleCommand } from '../commands.js';
import {
  _initTestDatabase,
  createMission,
  createMissionRole,
  getMission,
} from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  _initTestDatabase();
});

describe('Teams card tap → mission approved (same path as typed command)', () => {
  it('a mission:approve card payload approves the mission via handleCommand', () => {
    // Arrange: a proposed mission, exactly as /mission create would leave it.
    const missionId = 'm-roundtrip-001';
    createMission({
      id: missionId,
      entity: 'gpg',
      template_type: 'research',
      title: 'Round-trip approval proof',
    });
    createMissionRole({
      mission_id: missionId,
      role_name: 'researcher',
      model: 'sonnet',
    });
    expect(getMission(missionId)?.status).toBe('proposed');

    // Act 1 — translate the Adaptive Card Action.Submit payload (what the CEO's
    // tap delivers in activity.value.callback_data) into the command string.
    const command = callbackDataToCommand(`mission:approve:${missionId}`);
    expect(command).toBe(`/mission approve ${missionId}`);

    // Act 2 — route that command through the SAME handler the typed text
    // command uses. (In production, teams.ts onTurn writes this string into the
    // inbound message content, and index.ts onMessage feeds it to handleCommand.)
    const result = handleCommand(command!, 'owner');

    // Assert: handled, and the mission is now approved in SQLite.
    expect(result.handled).toBe(true);
    expect(result.response).toContain('Mission approved');
    expect(getMission(missionId)?.status).toBe('approved');
    expect(getMission(missionId)?.approved_at).toBeTruthy();
  });

  it('a mission:reject card payload rejects the mission via the same path', () => {
    const missionId = 'm-roundtrip-002';
    createMission({
      id: missionId,
      entity: 'gpg',
      template_type: 'research',
      title: 'Round-trip reject proof',
    });
    expect(getMission(missionId)?.status).toBe('proposed');

    const command = callbackDataToCommand(`mission:reject:${missionId}`);
    expect(command).toBe(`/mission reject ${missionId}`);

    const result = handleCommand(command!, 'owner');

    expect(result.handled).toBe(true);
    expect(getMission(missionId)?.status).toBe('rejected');
  });
});
