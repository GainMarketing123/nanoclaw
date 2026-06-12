import { Channel, NewMessage, SendDocumentOptions } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export async function routeOutboundDocument(
  channels: Channel[],
  jid: string,
  filePath: string,
  options?: SendDocumentOptions,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendDocument) {
    throw new Error(`Channel ${channel.name} does not support sendDocument`);
  }
  return channel.sendDocument(jid, filePath, options);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * JID prefixes for channels that were INTENTIONALLY retired (no longer
 * registered in the running build) but whose group rows still live in the DB.
 * Telegram (`tg:`) was removed 2026-06-03 in favour of Teams (CEO decision —
 * see memory feedback_no_telegram_retired); its absence is the correct, desired
 * state, so an IPC send targeting a retired JID must degrade quietly rather
 * than raise a false "No channel for JID" fault. Any unowned JID that is NOT in
 * this set is a genuine misroute (a live channel temporarily unmapped) and must
 * still surface as an error.
 */
export const RETIRED_CHANNEL_JID_PREFIXES = ['tg:'] as const;

export function isRetiredChannelJid(jid: string): boolean {
  return RETIRED_CHANNEL_JID_PREFIXES.some((p) => jid.startsWith(p));
}

/**
 * JID prefixes for LOGICAL aliases that no outbound channel ever owns.
 * `dispatch:{folder}` is the bridge's Paperclip-workspace form; the
 * result-delivery message path does not resolve dispatch→real, so a send to
 * such a JID can only fail ("No channel for JID"). Module-internal on
 * purpose — the public contract is isKnownUndeliverableJid (spec pre-review
 * finding 4); callers must never re-implement prefix checks.
 * host/host-executor.py carries a lockstep Python mirror
 * (NON_CHANNEL_JID_PREFIXES there), as does scripts/create-group.sh step 4.
 */
const NON_CHANNEL_JID_PREFIXES = ['dispatch:'] as const;

/**
 * Shared conservative deliverability predicate (al22 reland spec,
 * plans/al22-seed-orchestrator-reland-spec-2026-06-12.md, commit-review
 * round 1): true when the JID's SHAPE alone guarantees that NO outbound
 * channel can ever own it on the send path (findChannel → channel.ownsJid):
 *   - logical aliases (`dispatch:` — owned by no channel, never resolved on
 *     the send path), and
 *   - retired channels (`tg:` — sends raise RetiredChannelDropError by
 *     design).
 *
 * DELIBERATELY one-sided: a `false` result means "not KNOWABLY undeliverable
 * by shape", NOT "delivery guaranteed" — a registered, non-retired,
 * non-alias JID can still be unowned at send time (e.g. a WhatsApp `@g.us`
 * row while the WhatsApp channel is not running; channels register at
 * orchestrator startup, and a DB-side script cannot see them at all). Live
 * channel ownership at send time remains the authoritative check; this
 * predicate exists so writers of persistent routing targets
 * (scheduled_tasks.chat_jid, host-task callback_group, is_main promotion)
 * never store a target that is GUARANTEED dead. Per-call-site prefix lists
 * are how the wave-2 review spiral started — always use this.
 */
export function isKnownUndeliverableJid(jid: string): boolean {
  return (
    NON_CHANNEL_JID_PREFIXES.some((p) => jid.startsWith(p)) ||
    isRetiredChannelJid(jid)
  );
}

/**
 * Resolve a group FOLDER to its registered channel chat JID — undefined when
 * the folder has none (caller decides whether that fails closed or degrades).
 *
 * Skips rows whose JID shape is knowably undeliverable (logical `dispatch:`
 * aliases, retired channels). NOT a delivery guarantee — see
 * isKnownUndeliverableJid; runtime channel ownership at send time stays
 * authoritative.
 *
 * The registry holds at most one current JID per folder (single-JID-per-folder
 * invariant, enforced at the DB layer by setRegisteredGroup), but the
 * in-memory map can transiently carry stale extras and logical alias rows.
 * The scan therefore filters by shape and breaks any remaining tie
 * deterministically — lexicographically smallest JID — so object iteration
 * order never decides routing (spec pre-review finding 2; same rationale as
 * selectLiveMain's jid tie-break).
 */
export function resolveChannelJidForFolder(
  registeredGroups: Record<string, { folder: string }>,
  folder: string,
): string | undefined {
  let best: string | undefined;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder !== folder || isKnownUndeliverableJid(jid)) {
      continue;
    }
    if (best === undefined || jid < best) {
      best = jid;
    }
  }
  return best;
}

/**
 * Resolution result for seeding a scheduled task (see resolveSeedTarget).
 * `reason` is operator-facing — seeders print it and exit non-zero.
 */
export type SeedTargetResult =
  | { ok: true; jid: string; folder: string }
  | { ok: false; reason: string };

/**
 * Resolve the (chat_jid, group_folder) pair a seeded scheduled task must
 * target. The scheduler executes tasks by matching task.group_folder to a
 * registered group's folder and delivers output to task.chat_jid
 * (src/task-scheduler.ts), so BOTH must come from a real registered row —
 * never a constant folder, never an unvalidated JID. This closes the four
 * wave-2 seed-orchestrator review findings at root (al22 reland spec).
 *
 *   - explicitJid path: the JID must be a registered row AND deliverable
 *     (rejects retired `tg:` rows and `dispatch:` aliases with the same
 *     shared predicate); the folder is the row's.
 *   - default path: selectLiveMain over the DELIVERABLE is_main candidates —
 *     retirement-aware and deterministic, the same winner every runtime
 *     mirror computes.
 *
 * Validation is "registered + not knowably undeliverable by shape": a
 * DB-side seeder runs outside the orchestrator process and cannot see which
 * channels are live, so runtime channel ownership at send time remains the
 * authoritative delivery check (see isKnownUndeliverableJid).
 *
 * Pure function over pre-fetched rows: no DB handle, unit-testable.
 */
export function resolveSeedTarget(
  rows: Array<{ jid: string; folder: string; isMain: boolean }>,
  explicitJid?: string,
): SeedTargetResult {
  if (explicitJid !== undefined) {
    const row = rows.find((r) => r.jid === explicitJid);
    if (!row) {
      return {
        ok: false,
        reason: `--chat-jid ${explicitJid} is not a registered group JID`,
      };
    }
    if (isKnownUndeliverableJid(explicitJid)) {
      return {
        ok: false,
        reason:
          `--chat-jid ${explicitJid} is registered but knowably ` +
          `undeliverable (retired channel or logical alias) — no outbound ` +
          `channel can ever own it`,
      };
    }
    return { ok: true, jid: row.jid, folder: row.folder };
  }

  const live = selectLiveMain(rows.filter((r) => r.isMain));
  if (!live) {
    return {
      ok: false,
      reason:
        'no live main group found in registered_groups ' +
        '(every is_main row is retired or a logical alias, or none exists) — ' +
        'provide --chat-jid for an explicit live target',
    };
  }
  return { ok: true, jid: live.jid, folder: live.folder };
}

/**
 * Choose which `is_main` candidate should act as the main control group —
 * the JID that CEO alerts route to, and the survivor of load-time
 * single-main normalization (loadState in index.ts).
 *
 * KNOWABLY-UNDELIVERABLE JIDs are NEVER eligible (isKnownUndeliverableJid):
 * a retired JID cannot deliver anything, so keeping one as main silently
 * black-holes CEO alerts — the live `No channel for JID: tg:7322433447`
 * executor mis-route from the 2026-06-11 trace, where a legacy Telegram
 * main row survived the Teams migration as an `is_main = 1` row and the
 * DB-reading alert paths (host-executor.py send_alert, credential-proxy.ts
 * sendAlert, seed-orchestrator.ts) picked it via
 * `WHERE is_main = 1 LIMIT 1`. The same holds for logical `dispatch:` alias
 * rows (al22 reland spec, commit-review round 1): setRegisteredGroup now
 * rejects promoting one, but a legacy/hand-edited row must not win selection
 * in ANY runtime mirror. host-executor.py mirrors this selection in Python
 * (RETIRED_CHANNEL_JID_PREFIXES + NON_CHANNEL_JID_PREFIXES there must stay
 * in lockstep with this file), as does scripts/create-group.sh step 4.
 *
 * Among live candidates the canonical `folder === 'main'` row wins (that is
 * the row the schema migration promotes), else the row with the
 * lexicographically-smallest jid. The jid tie-break is load-bearing:
 * candidates come from `SELECT … WHERE is_main = 1` with NO ORDER BY, and
 * SQLite row order is undefined (it can change across a vacuum/rewrite).
 * With two live mains whose folders are both ≠ 'main' (e.g. a legacy
 * 'atlas_main' alongside 'atlas_teams'), a bare first-row fallback let each
 * runtime mirror (this file, host/host-executor.py select_live_main_row,
 * scripts/create-group.sh step 4) pick a DIFFERENT "main" — alerts emitted
 * from one folder while the shared mount was patched onto another (codex
 * 20924e0 finding 1). jid is registered_groups' primary key, so the
 * (folder-rank, jid) order is total and every runtime computes the same
 * winner from the same rows.
 * Returns undefined when NO live candidate exists — callers must treat that
 * as "no main group" rather than falling back to a retired JID.
 *
 * selectLiveMain returns the full candidate (callers that write privileged
 * IPC need the selected main's FOLDER too — the IPC watcher authorizes by
 * main-folder match, so host-side writers must emit from the live main's
 * own source directory, not a hard-coded one); selectLiveMainJid is the
 * jid-only convenience over it.
 */
export function selectLiveMain<T extends { jid: string; folder?: string }>(
  candidates: T[],
): T | undefined {
  const live = candidates.filter((c) => !isKnownUndeliverableJid(c.jid));
  if (live.length === 0) return undefined;
  // Deterministic total order: (folder === 'main' rank, then smallest jid).
  return live.reduce((best, c) => {
    const bestRank = best.folder === 'main' ? 0 : 1;
    const cRank = c.folder === 'main' ? 0 : 1;
    if (cRank !== bestRank) return cRank < bestRank ? c : best;
    return c.jid < best.jid ? c : best;
  });
}

export function selectLiveMainJid(
  candidates: Array<{ jid: string; folder?: string }>,
): string | undefined {
  return selectLiveMain(candidates)?.jid;
}

/**
 * Thrown when an IPC send targets a retired-channel JID (e.g. `tg:`) that no
 * live channel owns. This is an INTENTIONAL non-delivery, distinct from both a
 * successful send and a genuine misroute:
 *   - The IPC watcher (src/ipc.ts) must NOT log it as "sent" (a false success
 *     that misleads operators into thinking an alert/result was delivered) and
 *     must NOT unlink a document payload as if delivered.
 *   - It must NOT be routed to data/ipc/errors for retry (the channel is gone;
 *     retry is pointless) — unlike a non-retired unowned JID, which DOES throw a
 *     plain Error and IS preserved for investigation.
 * The watcher catches this specific type, logs a "dropped" outcome, and cleans
 * up the IPC file as handled (not errored).
 */
export class RetiredChannelDropError extends Error {
  readonly jid: string;
  constructor(jid: string) {
    super(`Retired channel for JID, dropping IPC send: ${jid}`);
    this.name = 'RetiredChannelDropError';
    this.jid = jid;
  }
}
