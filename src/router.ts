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
 * Choose which `is_main` candidate should act as the main control group —
 * the JID that CEO alerts route to, and the survivor of load-time
 * single-main normalization (loadState in index.ts).
 *
 * Retired-channel JIDs are NEVER eligible: a retired JID cannot deliver
 * anything, so keeping one as main silently black-holes CEO alerts — the
 * live `No channel for JID: tg:7322433447` executor mis-route from the
 * 2026-06-11 trace, where a legacy Telegram main row survived the Teams
 * migration as an `is_main = 1` row and the DB-reading alert paths
 * (host-executor.py send_alert, credential-proxy.ts sendAlert,
 * seed-orchestrator.ts) picked it via `WHERE is_main = 1 LIMIT 1`.
 * host-executor.py mirrors this selection in Python (RETIRED_CHANNEL_JID_
 * PREFIXES there must stay in lockstep with this file).
 *
 * Among live candidates the canonical `folder === 'main'` row wins (that is
 * the row the schema migration promotes), else the first encountered.
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
  const live = candidates.filter((c) => !isRetiredChannelJid(c.jid));
  return live.find((c) => c.folder === 'main') ?? live[0];
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
