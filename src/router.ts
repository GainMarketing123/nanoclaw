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
