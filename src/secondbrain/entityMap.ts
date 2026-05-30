/**
 * Cross-entity guardrail for the Teams channel.
 *
 * All businesses share ONE Microsoft 365 tenant, so the tenant ID is NOT a
 * safe discriminator — resolution MUST be by conversation. A Teams
 * conversationId maps to exactly one business entity slug; anything we can't
 * positively map to a known conversation is refused so one business can never
 * read another's memory.
 */
import { logger } from '../logger.js';

/**
 * Minimal identifying context lifted from a Teams activity.
 * `tenantId` is a secondary guard only (see isAllowedTenant); `conversationId`
 * is the primary, per-business discriminator.
 */
export interface TeamsContext {
  tenantId?: string;
  conversationId: string;
}

/** conversationId -> business entity slug (e.g. "19:abc@thread.v2" -> "gpg"). */
export type EntityMap = Record<string, string>;

/**
 * Resolve the business entity slug for a Teams conversation.
 *
 * Returns the slug mapped to `ctx.conversationId`, or `null` if the
 * conversation is unmapped. There is intentionally NO default: a `null`
 * return means the caller MUST refuse to answer, because guessing a default
 * entity would leak one business's memory into another business's chat.
 */
export function resolveEntitySlug(
  ctx: TeamsContext,
  map: EntityMap,
): string | null {
  const slug = map[ctx.conversationId];
  return slug ?? null;
}

/**
 * Secondary tenant guard. If `allowedTenantId` is configured, the activity's
 * tenant must match exactly. If it is unset (dev), allow through — the
 * per-conversation map remains the real gate.
 */
export function isAllowedTenant(
  ctx: TeamsContext,
  allowedTenantId: string | undefined,
): boolean {
  if (!allowedTenantId) return true;
  return ctx.tenantId === allowedTenantId;
}

/**
 * Parse the TEAMS_ENTITY_MAP env value into an EntityMap.
 * Missing or invalid JSON yields an empty map (fail-closed: every
 * conversation is then unmapped and refused) plus a warning.
 */
export function loadEntityMapFromEnv(raw: string | undefined): EntityMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as EntityMap;
    }
    logger.warn('TEAMS_ENTITY_MAP is not a JSON object — ignoring');
    return {};
  } catch (err) {
    logger.warn({ err }, 'TEAMS_ENTITY_MAP is not valid JSON — ignoring');
    return {};
  }
}
