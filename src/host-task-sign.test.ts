import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { HostTask, canonicalBytes, sign, verify } from './host-task-sign.js';

interface Fixture {
  key_hex: string;
  task: HostTask;
  expected_canonical: string;
  expected_sig: string;
}

const fixturePath = resolve(
  __dirname,
  '../test/fixtures/host-task-sig-vector.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const key = Buffer.from(fixture.key_hex, 'hex');

describe('host-task-sign', () => {
  it('matches shared vector and verify behavior', () => {
    expect(canonicalBytes(fixture.task).toString('utf8')).toBe(
      fixture.expected_canonical,
    );
    expect(sign(fixture.task, key)).toBe(fixture.expected_sig);
    expect(verify(fixture.task, key, fixture.task.issued_at)).toEqual({
      ok: true,
      reason: 'ok',
    });

    const tamperedProjectDir: HostTask = {
      ...fixture.task,
      project_dir: '/srv/projects/other',
    };
    expect(
      verify(tamperedProjectDir, key, tamperedProjectDir.issued_at),
    ).toEqual({
      ok: false,
      reason: 'bad_sig',
    });

    const expiredNow = fixture.task.expires_at + 1;
    expect(verify(fixture.task, key, expiredNow)).toEqual({
      ok: false,
      reason: 'expired',
    });

    const missingSig: HostTask = { ...fixture.task };
    delete missingSig._sig;
    expect(verify(missingSig, key, missingSig.issued_at)).toEqual({
      ok: false,
      reason: 'missing_sig',
    });

    // cross-review F2: a malformed task fails closed with a reason, never throws.
    const missingField: HostTask = { ...fixture.task };
    delete (missingField as Partial<HostTask>).project_dir;
    expect(verify(missingField, key, fixture.task.issued_at)).toEqual({
      ok: false,
      reason: 'bad_task',
    });

    const nonStringField = {
      ...fixture.task,
      prompt: 123,
    } as unknown as HostTask;
    expect(verify(nonStringField, key, fixture.task.issued_at)).toEqual({
      ok: false,
      reason: 'bad_task',
    });

    // cross-review round 2: a null numeric field is bad_task, not a throw.
    const nullNumeric = {
      ...fixture.task,
      tier: null,
    } as unknown as HostTask;
    expect(verify(nullNumeric, key, fixture.task.issued_at)).toEqual({
      ok: false,
      reason: 'bad_task',
    });

    // cross-review F3: an upper/mixed-case hex signature still verifies.
    const upperSig: HostTask = {
      ...fixture.task,
      _sig: fixture.task._sig!.toUpperCase(),
    };
    expect(verify(upperSig, key, fixture.task.issued_at)).toEqual({
      ok: true,
      reason: 'ok',
    });

    // cross-review F4: a non-hex _sig is missing_sig (strict), not bad_sig.
    const badHexSig: HostTask = {
      ...fixture.task,
      _sig: '+' + fixture.task._sig!.slice(1),
    };
    expect(verify(badHexSig, key, fixture.task.issued_at)).toEqual({
      ok: false,
      reason: 'missing_sig',
    });
  });
});
