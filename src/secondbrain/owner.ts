/**
 * THE OWNER GATE (security-critical, fail-closed).
 *
 * This bot is the CEO's private, all-access Atlas. It answers ONLY the owner's
 * Microsoft identity and HARD-REFUSES everyone else. For the owner it spans
 * every entity (the businesses + a personal space); cross-entity isolation
 * still lives in the brain's data layer — this gate is the sanctioned
 * superuser ABOVE it. The owner gate is therefore the ONLY thing protecting
 * every business's data from a non-owner, so it MUST fail closed: if no owner
 * is configured, nobody is the owner and the bot refuses everyone.
 */

/** Identity lifted from an inbound Teams activity's `from` field. */
export interface SenderIdentity {
  aadObjectId?: string;
  upn?: string;
  name?: string;
}

/** The configured owner identity. Either field (or both) may be set. */
export interface OwnerConfig {
  aadObjectId?: string;
  upn?: string;
}

/**
 * Is this sender the configured owner?
 *
 * FAIL-CLOSED: if NEITHER `owner.aadObjectId` nor `owner.upn` is set, no owner
 * is configured ⇒ nobody is the owner ⇒ return false (refuse everyone).
 *
 * Otherwise true ONLY if:
 *   - owner.aadObjectId is set AND sender.aadObjectId === owner.aadObjectId, OR
 *   - owner.upn is set AND sender.upn is set AND they are case-insensitively equal.
 *
 * Primary match is `aadObjectId` (stable, tenant-scoped); `upn` is a
 * convenience fallback.
 */
export function isOwner(sender: SenderIdentity, owner: OwnerConfig): boolean {
  const ownerAad = owner.aadObjectId?.trim();
  const ownerUpn = owner.upn?.trim();

  // Fail-closed: no owner configured ⇒ nobody is the owner.
  if (!ownerAad && !ownerUpn) return false;

  if (ownerAad && sender.aadObjectId && sender.aadObjectId === ownerAad) {
    return true;
  }

  if (
    ownerUpn &&
    sender.upn &&
    sender.upn.trim().toLowerCase() === ownerUpn.toLowerCase()
  ) {
    return true;
  }

  return false;
}

/**
 * Read the owner identity from the environment. Reads
 * `ATLAS_OWNER_AAD_OBJECT_ID` and `ATLAS_OWNER_UPN`, trims them, and omits
 * empties so an unset value never accidentally matches.
 */
export function loadOwnerConfigFromEnv(
  env: Record<string, string | undefined>,
): OwnerConfig {
  const config: OwnerConfig = {};
  const aad = env.ATLAS_OWNER_AAD_OBJECT_ID?.trim();
  const upn = env.ATLAS_OWNER_UPN?.trim();
  if (aad) config.aadObjectId = aad;
  if (upn) config.upn = upn;
  return config;
}
