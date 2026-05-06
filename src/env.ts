import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/**
 * Resolve where the canonical .env file lives.
 *
 * Mirrors the Python lib/atlas_paths.py contract: ATLAS_DIR env var wins,
 * fallback to ~/.atlas. Hardcoding process.cwd() (the prior behavior)
 * broke when the daemon launched with cwd != the install directory —
 * common under systemd, container entrypoints, and any non-default
 * service-user setup (Phase 3.2 nanoclaw-he case). Callers can still
 * pass an explicit dir to override (tests, alt-config layouts).
 */
function defaultEnvDir(): string {
  if (process.env.ATLAS_DIR) return process.env.ATLAS_DIR;
  if (process.platform !== 'win32' && process.env.HOME) {
    return path.join(process.env.HOME, '.atlas');
  }
  return path.join(os.homedir(), '.atlas');
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
