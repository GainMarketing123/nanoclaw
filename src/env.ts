import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Resolve where the canonical .env file lives.
 *
 * Default is the nanoclaw project root (process.cwd()). This matches the
 * convention used by every writer and reader in this repo:
 *   - setup/register.ts:72 (writer)         — process.cwd()
 *   - setup/verify.ts:26 (reader)           — process.cwd()
 *   - setup/environment.ts:16 (reader)      — process.cwd()
 *   - src/config.ts:20 (reader, PROJECT_ROOT) — process.cwd()
 *   - src/credential-proxy.ts:306 (reader)  — process.cwd()
 *
 * Codex e39da2b F1 BLOCKING fix: the prior default was ATLAS_DIR/~/.atlas,
 * which is atlas-engineering's install root — NOT nanoclaw's project root.
 * That mis-modeling silently broke the writer/reader contract: setup wrote
 * ASSISTANT_NAME etc. to projectRoot/.env while the runtime resolved
 * .env from ATLAS_DIR/.env (which is a different file owned by Atlas
 * Engineering with different secrets), so services started reading the
 * wrong file or no file at all even though setup reported "config present".
 *
 * Systemd / launchd units MUST set `WorkingDirectory=` to the nanoclaw
 * checkout — that is the project's existing deployment convention and
 * makes process.cwd() correct under daemonization. Tests / alt-config
 * layouts can still override via the explicit `dir` parameter.
 */
function defaultEnvDir(): string {
  return process.cwd();
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 *
 * @param keys  the env-var names to extract from .env
 * @param dir   optional override of the directory containing .env;
 *              defaults to ATLAS_DIR (env var or ~/.atlas).
 */
export function readEnvFile(
  keys: string[],
  dir: string = defaultEnvDir(),
): Record<string, string> {
  const envFile = path.join(dir, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
