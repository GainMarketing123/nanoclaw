import { readFileSync } from 'node:fs';

export interface HostTaskPolicy {
  entity: string;
  max_tier: number;
  allowed_project_dirs: string[];
  allowed_models: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parsePolicyEntry(value: unknown): HostTaskPolicy | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }

  const entry = value as Record<string, unknown>;
  if (typeof entry.entity !== 'string') {
    return null;
  }
  if (!Number.isInteger(entry.max_tier)) {
    return null;
  }
  if (!isStringArray(entry.allowed_project_dirs)) {
    return null;
  }
  if (!isStringArray(entry.allowed_models)) {
    return null;
  }

  return {
    entity: entry.entity,
    // Number.isInteger() guarantees a number at runtime but is not a TS
    // type-guard that narrows `unknown`, so assert after the validated check.
    max_tier: entry.max_tier as number,
    allowed_project_dirs: entry.allowed_project_dirs,
    allowed_models: entry.allowed_models,
  };
}

export function loadHostTaskPolicy(
  policyPath = '/etc/atlas/host-task-policy.json',
): Record<string, HostTaskPolicy> {
  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const out: Record<string, HostTaskPolicy> = {};
    for (const [folder, value] of Object.entries(parsed as Record<string, unknown>)) {
      const policy = parsePolicyEntry(value);
      if (policy !== null) {
        out[folder] = policy;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function policyForGroup(
  folder: string,
  policyPath?: string,
): HostTaskPolicy | null {
  const policy = loadHostTaskPolicy(policyPath);
  return policy[folder] ?? null;
}
