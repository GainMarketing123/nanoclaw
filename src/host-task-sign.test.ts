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

const fixturePath = resolve(__dirname, '../test/fixtures/host-task-sig-vector.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const key = Buffer.from(fixture.key_hex, 'hex');

describe('host-task-sign', () => {
  it('matches shared vector and verify behavior', () => {
    expect(canonicalBytes(fixture.task).toString('utf8')).toBe(fixture.expected_canonical);
    expect(sign(fixture.task, key)).toBe(fixture.expected_sig);
    expect(verify(fixture.task, key, fixture.task.issued_at)).toEqual({ ok: true, reason: 'ok' });

    const tamperedProjectDir: HostTask = {
      ...fixture.task,
      project_dir: '/srv/projects/other',
    };
    expect(verify(tamperedProjectDir, key, tamperedProjectDir.issued_at)).toEqual({
      ok: false,
      reason: 'bad_sig',
    });

    const expiredNow = fixture.task.expires_at + 1;
    expect(verify(fixture.task, key, expiredNow)).toEqual({ ok: false, reason: 'expired' });

    const missingSig: HostTask = { ...fixture.task };
    delete missingSig._sig;
    expect(verify(missingSig, key, missingSig.issued_at)).toEqual({
      ok: false,
      reason: 'missing_sig',
    });
  });
});
