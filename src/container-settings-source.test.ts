import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Enforcement-hook propagation source regression tests.
 *
 * INCIDENT (measured on the live VPS 2026-07-31): every NanoClaw business
 * channel was frozen on a stale enforcement-hook set. `atlas_teams` ran 54 of
 * 62 hooks (last propagation 2026-07-10), `atlas_gpg` 18, `atlas_main` 17, and
 * two registered groups had none at all.
 *
 * ROOT CAUSE: one constant was doing two unrelated jobs. `CLAUDE_CONFIG_DIR`
 * is the Claude CLI's env var for relocating the CREDENTIAL root; the
 * 2026-07-11 shared-identity OAuth cutover set it to `/home/nanoclaw-he/.claude`
 * on `nanoclaw.service` so the credential proxy could find `.credentials.json`.
 * `writeContainerSettings()` reused the same constant (via the
 * `HOST_CLAUDE_DIR` alias) to locate the RULEBOOK — but the rulebook never
 * moved; it still lives at `/home/atlas/.claude/settings.json`.
 * `/home/nanoclaw-he/.claude/settings.json` is literally `{}`, so the
 * manifest parity gate compared 62 required hooks against zero registered
 * ones, correctly refused to propagate, and fell back to whatever each group
 * already had — logging `container_settings_parity_refused` on every spawn.
 *
 * The parity gate was behaving CORRECTLY; it was pointed at the wrong file.
 * These tests pin the two halves apart so a future credential relocation can
 * never again silently freeze enforcement:
 *
 *  1. the settings source must be read from the SETTINGS source dir, not the
 *     credential dir (this is the test that was RED before the fix);
 *  2. the credential dir must remain independently configurable;
 *  3. the parity gate must still fail CLOSED when the source really is
 *     hook-less — the fix must not weaken the gate that caught this.
 */

interface Dirs {
  root: string;
  credentialDir: string;
  settingsSourceDir: string;
  atlasDir: string;
  groupSettingsFile: string;
}

const tempRoots: string[] = [];

function makeDirs(): Dirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-settings-src-'));
  tempRoots.push(root);

  // Stands in for /home/nanoclaw-he/.claude — credentials only. Its
  // settings.json is `{}`, byte-for-byte what the live VPS has.
  const credentialDir = path.join(root, 'nanoclaw-he', '.claude');
  fs.mkdirSync(credentialDir, { recursive: true });
  fs.writeFileSync(path.join(credentialDir, 'settings.json'), '{}\n');

  // Stands in for /home/atlas/.claude — the real rulebook.
  const settingsSourceDir = path.join(root, 'atlas', '.claude');
  fs.mkdirSync(settingsSourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsSourceDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'python3 /home/atlas/.atlas/hooks/session-start.py',
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                {
                  type: 'command',
                  command:
                    'python3 /home/atlas/.atlas/hooks/pretool-discipline.py',
                },
              ],
            },
          ],
        },
        env: { ATLAS_HOST_MODE: 'production' },
      },
      null,
      2,
    ) + '\n',
  );

  // Stands in for /home/atlas/.atlas — carries the enforcement manifest the
  // parity gate validates the source against.
  const atlasDir = path.join(root, 'atlas', '.atlas');
  fs.mkdirSync(atlasDir, { recursive: true });
  fs.writeFileSync(
    path.join(atlasDir, 'enforcement-manifest.json'),
    JSON.stringify({
      required_hooks: [
        { event: 'SessionStart', script: 'hooks/session-start.py' },
        {
          event: 'PreToolUse',
          matcher: 'Edit|Write',
          script: 'hooks/pretool-discipline.py',
        },
      ],
    }) + '\n',
  );

  const groupDir = path.join(root, 'sessions', 'atlas_teams', '.claude');
  fs.mkdirSync(groupDir, { recursive: true });

  return {
    root,
    credentialDir,
    settingsSourceDir,
    atlasDir,
    groupSettingsFile: path.join(groupDir, 'settings.json'),
  };
}

/**
 * Import container-runner with a config module whose CREDENTIAL dir and
 * SETTINGS SOURCE dir are deliberately DIFFERENT directories. That divergence
 * is the whole point: before the fix the settings source was an alias of the
 * credential dir, so pointing them at different places is what exposes the
 * defect.
 */
async function importWithConfig(dirs: Dirs, settingsSourceDir: string) {
  vi.resetModules();

  vi.doMock('./config.js', () => ({
    ATLAS_DIR: dirs.atlasDir,
    ATLAS_STATE_DIR: dirs.atlasDir,
    BRIDGE_CALLBACK_PORT: 3002,
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: path.join(dirs.root, 'data'),
    GROUPS_DIR: path.join(dirs.root, 'groups'),
    HOME_DIR: path.join(dirs.root, 'atlas'),
    // Credential root — the Claude CLI env var. Deliberately NOT the rulebook.
    HOST_CLAUDE_DIR: dirs.credentialDir,
    CLAUDE_CONFIG_DIR: dirs.credentialDir,
    // Rulebook root — what writeContainerSettings must actually read.
    CLAUDE_SETTINGS_SOURCE_DIR: settingsSourceDir,
    IDLE_TIMEOUT: 1800000,
    MOUNT_ALLOWLIST_PATH: path.join(dirs.root, 'mount-allowlist.json'),
    TIMEZONE: 'America/New_York',
  }));

  const warn = vi.fn();
  const info = vi.fn();
  vi.doMock('./logger.js', () => ({
    logger: { debug: vi.fn(), info, warn, error: vi.fn() },
  }));

  const mod = await import('./container-runner.js');
  return { writeContainerSettings: mod.writeContainerSettings, warn, info };
}

function countHookCommands(settings: {
  hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
}): number {
  let n = 0;
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries) n += (entry.hooks ?? []).length;
  }
  return n;
}

afterEach(() => {
  vi.doUnmock('./config.js');
  vi.doUnmock('./logger.js');
  vi.resetModules();
  vi.clearAllMocks();
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('container enforcement-hook propagation source', () => {
  it('reads the rulebook from the settings source, NOT the credential dir', async () => {
    const dirs = makeDirs();
    const { writeContainerSettings } = await importWithConfig(
      dirs,
      dirs.settingsSourceDir,
    );

    writeContainerSettings(dirs.groupSettingsFile);

    // THE REGRESSION: pre-fix this file was never written at all, because the
    // function read the credential dir's `{}` and the parity gate refused.
    expect(
      fs.existsSync(dirs.groupSettingsFile),
      'container settings.json was not written — enforcement hooks did not propagate',
    ).toBe(true);

    const written = JSON.parse(
      fs.readFileSync(dirs.groupSettingsFile, 'utf-8'),
    );
    expect(countHookCommands(written)).toBe(2);

    // Host paths must be rewritten to the container namespace.
    expect(JSON.stringify(written)).toContain(
      '/home/node/.atlas/hooks/session-start.py',
    );
    expect(JSON.stringify(written)).toContain(
      '/home/node/.atlas/hooks/pretool-discipline.py',
    );
    expect(JSON.stringify(written)).not.toContain('/home/atlas/.atlas/hooks/');
  });

  it('stamps the freshness marker from the settings source mtime', async () => {
    const dirs = makeDirs();
    const { writeContainerSettings } = await importWithConfig(
      dirs,
      dirs.settingsSourceDir,
    );

    writeContainerSettings(dirs.groupSettingsFile);

    const marker = `${dirs.groupSettingsFile}.source-mtime`;
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(
      fs
        .statSync(path.join(dirs.settingsSourceDir, 'settings.json'))
        .mtimeMs.toString(),
    );
  });

  it('keeps the credential dir independently configurable (no re-aliasing)', async () => {
    const dirs = makeDirs();
    const config = await import('./config.js');
    // Guard the shape of the real module, not the mock: the two roles must be
    // separate exported constants so a future credential move cannot drag the
    // rulebook with it.
    expect(typeof config.CLAUDE_SETTINGS_SOURCE_DIR).toBe('string');
    expect(typeof config.CLAUDE_CONFIG_DIR).toBe('string');
  });

  it('still fails CLOSED when the settings source genuinely has no hooks', async () => {
    const dirs = makeDirs();
    // Point the SETTINGS SOURCE at the hook-less `{}` file. The parity gate
    // must still refuse — the fix relocates the read, it must not weaken the
    // gate that caught the incident.
    const { writeContainerSettings, warn } = await importWithConfig(
      dirs,
      dirs.credentialDir,
    );

    writeContainerSettings(dirs.groupSettingsFile);

    expect(fs.existsSync(dirs.groupSettingsFile)).toBe(false);
    expect(fs.existsSync(`${dirs.groupSettingsFile}.source-mtime`)).toBe(false);
    expect(
      warn.mock.calls.some(
        (call) =>
          (call[0] as { event?: string })?.event ===
          'container_settings_parity_refused',
      ),
      'parity gate must still refuse a hook-less source',
    ).toBe(true);
  });
});
