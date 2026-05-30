/**
 * Microsoft Teams channel (Lane B).
 *
 * DORMANT until `src/channels/index.ts` imports this module — the barrel does
 * NOT import it yet, so registering this channel has zero effect on the live
 * Telegram bot. See teams/PROVISIONING.md step 7 ("THE ON-SWITCH").
 *
 * Uses the Bot Framework `CloudAdapter` (the supported successor to the
 * deprecated BotFrameworkAdapter) plus a minimal node `http` server — no
 * restify dependency. The chat path talks to the Second-Brain via the thin
 * client and renders answers through the shared, transport-agnostic helpers.
 */
import http from 'http';
import {
  ActivityTypes,
  CardFactory,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  type Activity,
  type ConversationReference,
} from 'botbuilder';

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';

export const TEAMS_JID_PREFIX = 'msteams:';

// Bound the proactive-send reference cache so a long-running process with high
// conversation churn cannot grow it without limit. Oldest entries evict first.
const TEAMS_MAX_REFERENCES = 1000;

/**
 * Build the canonical chat JID for a Teams conversation id.
 * Mirrors the `tg:` convention from telegram.ts.
 */
export function teamsJid(conversationId: string): string {
  return `${TEAMS_JID_PREFIX}${conversationId}`;
}

/**
 * Translate an inbound Teams message Activity into nanoclaw's NewMessage.
 * Pure + exported so the activity-handling contract is testable without
 * binding a port or constructing the adapter.
 */
export function buildInboundMessage(activity: Partial<Activity>): {
  chatJid: string;
  message: NewMessage;
  chatName: string;
  isGroup: boolean;
} {
  const conversationId = activity.conversation?.id ?? '';
  const chatJid = teamsJid(conversationId);
  const timestamp = new Date().toISOString();
  const senderName = activity.from?.name ?? activity.from?.id ?? 'Unknown';
  // Teams "personal" conversations are 1:1; "groupChat"/"channel" are groups.
  const conversationType = (activity.conversation as { conversationType?: string })
    ?.conversationType;
  const isGroup =
    conversationType === 'groupChat' || conversationType === 'channel';
  const chatName = activity.conversation?.name ?? senderName;

  const message: NewMessage = {
    id: activity.id ?? '',
    chat_jid: chatJid,
    sender: activity.from?.id ?? '',
    sender_name: senderName,
    content: activity.text ?? '',
    timestamp,
    is_from_me: false,
  };

  return { chatJid, message, chatName, isGroup };
}

/** Minimal botbuilder-compatible Request built from a parsed http body. */
interface BotRequest {
  body?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
}

/** Wrap a node ServerResponse in the botbuilder Response shape. */
function toBotResponse(res: http.ServerResponse): {
  socket: unknown;
  end: (...args: unknown[]) => unknown;
  header: (name: string, value: unknown) => unknown;
  send: (...args: unknown[]) => unknown;
  status: (code: number) => unknown;
} {
  return {
    socket: res.socket,
    end: (...args: unknown[]) => (res.end as (...a: unknown[]) => unknown)(...args),
    header: (name: string, value: unknown) =>
      res.setHeader(name, value as string | number | string[]),
    send: (body?: unknown) => {
      if (body !== undefined) {
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      } else {
        res.end();
      }
      return res;
    },
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
  };
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private readonly appId: string;
  private readonly appPassword: string;
  private readonly tenantId: string;
  private readonly opts: ChannelOpts;
  private readonly port: number;

  private adapter: CloudAdapter | null = null;
  private server: http.Server | null = null;
  private connected = false;
  // chatJid -> conversation reference, for proactive (outbound) sends.
  private readonly references = new Map<string, Partial<ConversationReference>>();

  constructor(
    appId: string,
    appPassword: string,
    tenantId: string,
    opts: ChannelOpts,
    extras: { port: number },
  ) {
    this.appId = appId;
    this.appPassword = appPassword;
    this.tenantId = tenantId;
    this.opts = opts;
    this.port = extras.port;
  }

  async connect(): Promise<void> {
    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppTenantId: this.tenantId,
    });
    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (context, error) => {
      logger.error({ err: error }, 'Teams turn error');
    };

    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => {
        server.removeListener('listening', onListening);
        logger.error({ err, port: this.port }, 'Teams adapter failed to bind');
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        this.connected = true;
        logger.info({ port: this.port }, 'Teams adapter listening');
        resolve();
      };
      server.once('error', onError);
      server.listen(this.port, onListening);
    });
  }

  /** Route an incoming HTTP request; only POST /api/messages is handled. */
  private handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.method !== 'POST' || req.url !== '/api/messages') {
      res.statusCode = 404;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (raw) body = JSON.parse(raw);
      } catch (err) {
        logger.warn({ err }, 'Teams: unparseable request body');
        res.statusCode = 400;
        res.end();
        return;
      }

      const botReq: BotRequest = {
        body,
        headers: req.headers,
        method: req.method,
      };

      this.adapter!.process(
        botReq as never,
        toBotResponse(res) as never,
        (context) => this.onTurn(context),
      ).catch((err) => {
        logger.error({ err }, 'Teams: adapter.process failed');
      });
    });
  }

  /** Per-turn bot logic — invoked by the adapter with an authenticated context. */
  private async onTurn(context: TurnContext): Promise<void> {
    const activity = context.activity;
    if (activity.type !== ActivityTypes.Message) return;

    const { chatJid, message, chatName, isGroup } =
      buildInboundMessage(activity);

    // Save the conversation reference so we can send proactively later.
    this.references.set(
      chatJid,
      TurnContext.getConversationReference(activity),
    );
    if (this.references.size > TEAMS_MAX_REFERENCES) {
      const oldest = this.references.keys().next().value;
      if (oldest !== undefined) this.references.delete(oldest);
    }

    this.opts.onChatMetadata(
      chatJid,
      message.timestamp,
      chatName,
      'teams',
      isGroup,
    );
    this.opts.onMessage(chatJid, message);

    logger.info({ chatJid, sender: message.sender_name }, 'Teams message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ref = this.references.get(jid);
    if (!this.adapter || !ref) {
      logger.warn({ jid }, 'Teams: no saved conversation reference; cannot send');
      return;
    }
    try {
      await this.adapter.continueConversationAsync(this.appId, ref, async (ctx) => {
        await ctx.sendActivity(text);
      });
      logger.info({ jid, length: text.length }, 'Teams message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Teams message');
    }
  }

  async sendMessageWithKeyboard(
    jid: string,
    text: string,
    buttons: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    const ref = this.references.get(jid);
    if (!this.adapter || !ref) {
      logger.warn(
        { jid },
        'Teams: no saved conversation reference; cannot send keyboard',
      );
      return;
    }

    const actions = buttons.flat().map((btn) => ({
      type: 'Action.Submit',
      title: btn.text,
      data: { callback_data: btn.callback_data },
    }));
    const card = CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      version: '1.4',
      body: [{ type: 'TextBlock', text, wrap: true }],
      actions,
    });

    try {
      await this.adapter.continueConversationAsync(this.appId, ref, async (ctx) => {
        await ctx.sendActivity({ attachments: [card] });
      });
      logger.info(
        { jid, buttonCount: buttons.flat().length },
        'Teams message with keyboard sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Teams keyboard message');
      await this.sendMessage(jid, text);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(TEAMS_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.adapter = null;
    this.references.clear();
    logger.info('Teams adapter stopped');
  }
}

registerChannel('teams', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'MICROSOFT_APP_ID',
    'MICROSOFT_APP_PASSWORD',
    'TEAMS_BOT_TENANT_ID',
    'TEAMS_ADAPTER_PORT',
  ]);
  const appId = process.env.MICROSOFT_APP_ID || env.MICROSOFT_APP_ID || '';
  const appPassword =
    process.env.MICROSOFT_APP_PASSWORD || env.MICROSOFT_APP_PASSWORD || '';
  const tenantId =
    process.env.TEAMS_BOT_TENANT_ID || env.TEAMS_BOT_TENANT_ID || '';
  const port = Number(
    process.env.TEAMS_ADAPTER_PORT || env.TEAMS_ADAPTER_PORT || 3978,
  );
  if (!appId || !appPassword) {
    logger.warn('Teams: MICROSOFT_APP_ID/PASSWORD not set — skipping');
    return null;
  }
  return new TeamsChannel(appId, appPassword, tenantId, opts, { port });
});
