/**
 * Microsoft Teams channel — the primary CEO command channel.
 *
 * LIVE: `src/channels/index.ts` imports this module (the on-switch was flipped
 * 2026-06-03 when the Telegram channel was removed). See teams/PROVISIONING.md.
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
import {
  isOwner,
  loadOwnerConfigFromEnv,
  OwnerConfig,
  SenderIdentity,
} from '../secondbrain/owner.js';

export const TEAMS_JID_PREFIX = 'msteams:';

/**
 * Whitelisted mission verbs an Adaptive Card button may invoke. The card
 * producer (`src/ipc.ts`) emits approve / reject / status; stop is included
 * because the `/mission` command supports it and a future card may surface it.
 * Anything outside this set is NOT synthesized into a command (fail-closed) —
 * an unexpected `callback_data` must never be coerced into a privileged verb.
 */
const TEAMS_CARD_MISSION_VERBS = new Set([
  'approve',
  'reject',
  'stop',
  'status',
]);

/**
 * Translate an Adaptive Card `Action.Submit` payload's `callback_data` into the
 * equivalent text command string, or return null if it is not a recognized
 * card action.
 *
 * The card producer emits `callback_data: "mission:<verb>:<missionId>"` (see
 * `src/ipc.ts`). We translate that to `"/mission <verb> <missionId>"` so a
 * button tap is routed through the SAME `handleCommand` path the typed text
 * commands use — one authorization gate, one code path. No second approval
 * surface to secure.
 *
 * Fail-closed: only the whitelisted verbs are translated; a malformed or
 * unknown payload returns null and the tap is treated as an ordinary (empty)
 * message rather than being coerced into a command.
 */
export function callbackDataToCommand(callbackData: unknown): string | null {
  if (typeof callbackData !== 'string') return null;
  const parts = callbackData.split(':');
  // Shape: "mission:<verb>:<missionId>" — missionId may itself contain no ':'.
  if (parts.length !== 3) return null;
  const [namespace, verb, missionId] = parts;
  if (namespace !== 'mission') return null;
  if (!TEAMS_CARD_MISSION_VERBS.has(verb)) return null;
  if (!missionId) return null;
  return `/mission ${verb} ${missionId}`;
}

/**
 * Extract the `callback_data` field from an Adaptive Card submit activity's
 * `value`. An `Action.Submit` tap arrives as a Message activity whose `value`
 * carries the button's `data` object (`{ callback_data: "..." }`); `text` is
 * usually empty.
 */
function readCallbackData(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'callback_data' in value) {
    const cb = (value as { callback_data?: unknown }).callback_data;
    return typeof cb === 'string' ? cb : undefined;
  }
  return undefined;
}

// Bound the proactive-send reference cache so a long-running process with high
// conversation churn cannot grow it without limit. Oldest entries evict first.
const TEAMS_MAX_REFERENCES = 1000;

/**
 * Build the canonical chat JID for a Teams conversation id.
 * Follows the same per-channel JID-prefix convention used across channels
 * (e.g. WhatsApp `…@s.whatsapp.net`, Discord `dc:`, the retired `tg:`).
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
  isPersonal: boolean;
  unrecognizedCardAction: boolean;
} {
  const conversationId = activity.conversation?.id ?? '';
  const chatJid = teamsJid(conversationId);
  const timestamp = new Date().toISOString();
  const senderName = activity.from?.name ?? activity.from?.id ?? 'Unknown';

  // Adaptive Card Action.Submit tap: the button payload lives in
  // `activity.value` (`{ callback_data: "mission:<verb>:<id>" }`), and
  // `activity.text` is usually empty. Translate a recognized card action into
  // the equivalent text command so it rides the SAME handleCommand path the
  // typed commands use (§2.4 of the Teams migration spec).
  //
  // Fail-closed (§2.4): if the tap carries a `callback_data` we do NOT
  // recognize, we must NOT silently downgrade it into an ordinary (usually
  // empty-text) chat message that flows on to onMessage / the conversation
  // pipeline. `unrecognizedCardAction` flags that case so onTurn can drop the
  // turn before it enters the system. A genuine text message (no
  // `callback_data`) is unaffected.
  const callbackData = readCallbackData(activity.value);
  const synthesizedCommand = callbackData
    ? callbackDataToCommand(callbackData)
    : null;
  const unrecognizedCardAction =
    callbackData !== undefined && synthesizedCommand === null;
  const content = synthesizedCommand ?? activity.text ?? '';
  // Teams "personal" conversations are 1:1; "groupChat"/"channel" are groups.
  const conversationType = (
    activity.conversation as { conversationType?: string }
  )?.conversationType;
  const isGroup =
    conversationType === 'groupChat' || conversationType === 'channel';
  // Auto-registration of the main control surface keys off this STRICT,
  // fail-closed predicate — NOT "!isGroup". An unrecognized or missing
  // conversationType must NOT be treated as the owner's private DM, or a
  // misclassified chat could be bound as the all-access control group.
  const isPersonal = conversationType === 'personal';
  const chatName = activity.conversation?.name ?? senderName;

  const message: NewMessage = {
    id: activity.id ?? '',
    chat_jid: chatJid,
    sender: activity.from?.id ?? '',
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: false,
  };

  return {
    chatJid,
    message,
    chatName,
    isGroup,
    isPersonal,
    unrecognizedCardAction,
  };
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
    end: (...args: unknown[]) =>
      (res.end as (...a: unknown[]) => unknown)(...args),
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
  private readonly ownerConfig: OwnerConfig;
  private readonly opts: ChannelOpts;
  private readonly port: number;

  private adapter: CloudAdapter | null = null;
  private server: http.Server | null = null;
  private connected = false;
  // chatJid -> conversation reference, for proactive (outbound) sends.
  private readonly references = new Map<
    string,
    Partial<ConversationReference>
  >();

  constructor(
    appId: string,
    appPassword: string,
    tenantId: string,
    ownerConfig: OwnerConfig,
    opts: ChannelOpts,
    extras: { port: number },
  ) {
    this.appId = appId;
    this.appPassword = appPassword;
    this.tenantId = tenantId;
    this.ownerConfig = ownerConfig;
    this.opts = opts;
    this.port = extras.port;
  }

  async connect(): Promise<void> {
    const auth = new ConfigurationBotFrameworkAuthentication({
      // Single-tenant is mandatory: Microsoft deprecated multi-tenant bot
      // creation after 2025-07-31, and all businesses share one M365 tenant.
      // Without MicrosoftAppType the SDK assumes multi-tenant and token
      // acquisition mismatches the single-tenant app registration (401s).
      MicrosoftAppType: 'SingleTenant',
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
      )
        .catch((err) => {
          logger.error({ err }, 'Teams: adapter.process failed');
        })
        .finally(() => {
          // Always close the socket. A well-formed Teams activity is answered by
          // adapter.process itself; but a malformed-but-valid-JSON POST (one the
          // adapter neither answers nor rejects on) would otherwise leave the
          // request hanging until the client times out. End it if nothing did.
          if (!res.writableEnded) res.end();
        });
    });
  }

  /** Per-turn bot logic — invoked by the adapter with an authenticated context. */
  private async onTurn(context: TurnContext): Promise<void> {
    const activity = context.activity;
    if (activity.type !== ActivityTypes.Message) return;

    // THE OWNER GATE (fail-closed). This bot is the CEO's private all-access
    // Atlas; it answers ONLY the owner's identity and HARD-REFUSES everyone
    // else. A non-owner message never enters the system: we do not save the
    // reference, do not record chat metadata, and do not call onMessage.
    const sender: SenderIdentity = {
      aadObjectId: activity.from?.aadObjectId,
      upn: (activity.from as { userPrincipalName?: string } | undefined)
        ?.userPrincipalName,
      name: activity.from?.name,
    };
    if (!isOwner(sender, this.ownerConfig)) {
      logger.warn(
        { sender: sender.aadObjectId ?? sender.name },
        'Teams: refusing non-owner',
      );
      await context.sendActivity(
        "This is the CEO's private Atlas. It isn't available to other accounts.",
      );
      return;
    }

    const {
      chatJid,
      message,
      chatName,
      isGroup,
      isPersonal,
      unrecognizedCardAction,
    } = buildInboundMessage(activity);

    // Fail-closed on unrecognized Adaptive Card actions (§2.4). The tap passed
    // the owner gate, but its `callback_data` did not map to a known command.
    // Do NOT let it through as an (empty-text) chat message: drop the turn
    // before saving the reference, registering the chat, or calling onMessage,
    // so an unexpected card payload can never be coerced into the normal
    // conversation pipeline on the all-access main chat.
    if (unrecognizedCardAction) {
      logger.warn(
        { chatJid, value: activity.value },
        'Teams: dropping unrecognized Adaptive Card action',
      );
      return;
    }

    // Save the conversation reference so we can send proactively later.
    this.references.set(
      chatJid,
      TurnContext.getConversationReference(activity),
    );
    if (this.references.size > TEAMS_MAX_REFERENCES) {
      const oldest = this.references.keys().next().value;
      if (oldest !== undefined) this.references.delete(oldest);
    }

    // The owner gate above guarantees this message is from the verified owner.
    // For the owner's 1:1 (personal) chat ONLY, ensure it is registered as the
    // main control group BEFORE the message is stored, so the orchestrator's
    // message loop — which only acts on registered JIDs — actually picks it up
    // and replies. Gated on the STRICT `isPersonal` predicate (fail-closed): a
    // group/channel OR an unrecognized/missing conversationType is never
    // auto-bound as the all-access control surface. (isGroup stays for chat
    // metadata; isPersonal is the registration gate.)
    if (isPersonal) {
      this.opts.ensureOwnerMainGroup?.(chatJid);
    }

    this.opts.onChatMetadata(
      chatJid,
      message.timestamp,
      chatName,
      'teams',
      isGroup,
    );
    this.opts.onMessage(chatJid, message);

    logger.info(
      { chatJid, sender: message.sender_name },
      'Teams message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ref = this.references.get(jid);
    if (!this.adapter || !ref) {
      logger.warn(
        { jid },
        'Teams: no saved conversation reference; cannot send',
      );
      return;
    }
    try {
      await this.adapter.continueConversationAsync(
        this.appId,
        ref,
        async (ctx) => {
          await ctx.sendActivity(text);
        },
      );
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
      await this.adapter.continueConversationAsync(
        this.appId,
        ref,
        async (ctx) => {
          await ctx.sendActivity({ attachments: [card] });
        },
      );
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
    'ATLAS_OWNER_AAD_OBJECT_ID',
    'ATLAS_OWNER_UPN',
  ]);
  const appId = process.env.MICROSOFT_APP_ID || env.MICROSOFT_APP_ID || '';
  const appPassword =
    process.env.MICROSOFT_APP_PASSWORD || env.MICROSOFT_APP_PASSWORD || '';
  const tenantId =
    process.env.TEAMS_BOT_TENANT_ID || env.TEAMS_BOT_TENANT_ID || '';
  const port = Number(
    process.env.TEAMS_ADAPTER_PORT || env.TEAMS_ADAPTER_PORT || 3978,
  );
  if (!appId || !appPassword || !tenantId) {
    logger.warn(
      'Teams: MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD / TEAMS_BOT_TENANT_ID not all set — skipping (single-tenant bots require the tenant id)',
    );
    return null;
  }

  // THE OWNER GATE config. This bot is the CEO's private Atlas; it answers
  // only this identity. If neither field is set the gate fails closed at
  // runtime (refuses ALL users), so we still construct the channel — a bot
  // that refuses everyone is correct, a bot that silently never starts is not.
  const ownerConfig = loadOwnerConfigFromEnv({
    ATLAS_OWNER_AAD_OBJECT_ID:
      process.env.ATLAS_OWNER_AAD_OBJECT_ID || env.ATLAS_OWNER_AAD_OBJECT_ID,
    ATLAS_OWNER_UPN: process.env.ATLAS_OWNER_UPN || env.ATLAS_OWNER_UPN,
  });
  if (!ownerConfig.aadObjectId && !ownerConfig.upn) {
    logger.warn(
      'Teams: no ATLAS_OWNER identity configured — the bot will refuse ALL users until set',
    );
  }

  return new TeamsChannel(appId, appPassword, tenantId, ownerConfig, opts, {
    port,
  });
});
