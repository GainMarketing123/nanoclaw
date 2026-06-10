import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock node http so connect() never binds a real port.
const serverRef = vi.hoisted(() => ({ current: null as any }));
vi.mock('http', () => {
  class MockServer {
    handler: any;
    constructor(handler: any) {
      this.handler = handler;
      serverRef.current = this;
    }
    once(_event: string, _cb: (...args: any[]) => void) {
      return this;
    }
    removeListener(_event: string, _cb: (...args: any[]) => void) {
      return this;
    }
    listen(_port: number, cb: () => void) {
      cb();
      return this;
    }
    close(cb: () => void) {
      cb();
    }
  }
  return {
    default: {
      createServer: (handler: any) => new MockServer(handler),
    },
  };
});

// --- botbuilder mock ---

const adapterRef = vi.hoisted(() => ({ current: null as any }));
// Captures the sendActivity spy of the most recent turn context so tests can
// assert the owner-gate refusal reply.
const lastTurnRef = vi.hoisted(() => ({ sendActivity: null as any }));

vi.mock('botbuilder', () => ({
  ActivityTypes: { Message: 'message' },
  CloudAdapter: class MockCloudAdapter {
    onTurnError: any = null;
    // process() drives the channel's real onTurn logic with a context built
    // from the request body — mirroring how the live adapter authenticates
    // then invokes the bot logic.
    process = vi.fn(
      async (req: any, _res: any, logic: (ctx: any) => Promise<void>) => {
        const sendActivity = vi.fn().mockResolvedValue(undefined);
        lastTurnRef.sendActivity = sendActivity;
        await logic({ activity: req.body, sendActivity });
      },
    );
    continueConversationAsync = vi.fn(
      async (_appId: string, _ref: any, logic: (ctx: any) => Promise<void>) => {
        await logic({ sendActivity: vi.fn().mockResolvedValue(undefined) });
      },
    );
    constructor() {
      adapterRef.current = this;
    }
  },
  ConfigurationBotFrameworkAuthentication: class {
    constructor(_opts: any) {}
  },
  TurnContext: {
    getConversationReference: vi.fn((activity: any) => ({
      conversation: { id: activity.conversation?.id },
    })),
  },
  CardFactory: {
    adaptiveCard: vi.fn((card: any) => ({
      contentType: 'adaptive',
      content: card,
    })),
  },
}));

import {
  TeamsChannel,
  teamsJid,
  buildInboundMessage,
  callbackDataToCommand,
} from './teams.js';
import type { ChannelOpts } from './registry.js';
import {
  maybeHandleAskMessage,
  parseAskQuestion,
  senderIdentityFromMessage,
  ASK_PROGRESS_PING,
} from '../secondbrain/askDispatch.js';
import type { SecondBrainClient, AskResult } from '../secondbrain/client.js';
import type { NewMessage } from '../types.js';

function createTestOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

const OWNER = { aadObjectId: 'owner-aad-1' };

function makeChannel(opts: ChannelOpts = createTestOpts()) {
  return new TeamsChannel('app-id', 'app-pass', 'tenant-1', OWNER, opts, {
    port: 3978,
  });
}

/**
 * Drive a POST /api/messages through the mocked http server handler so the
 * channel runs its real handleHttp -> adapter.process -> onTurn path.
 */
async function postActivity(activity: any): Promise<void> {
  const handler = serverRef.current.handler;
  const dataCbs: Array<(c: Buffer) => void> = [];
  const endCbs: Array<() => void> = [];
  const req = {
    method: 'POST',
    url: '/api/messages',
    headers: {},
    on(event: string, cb: any) {
      if (event === 'data') dataCbs.push(cb);
      if (event === 'end') endCbs.push(cb);
      return req;
    },
  };
  const res = {
    statusCode: 200,
    socket: {},
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  handler(req, res);
  for (const cb of dataCbs) cb(Buffer.from(JSON.stringify(activity)));
  for (const cb of endCbs) cb();
  // Let the async adapter.process chain settle.
  await new Promise((r) => setImmediate(r));
}

describe('TeamsChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterRef.current = null;
    serverRef.current = null;
  });

  describe('ownsJid', () => {
    it('owns msteams: JIDs', () => {
      expect(makeChannel().ownsJid('msteams:19:abc@thread.v2')).toBe(true);
    });

    it('does not own telegram JIDs', () => {
      expect(makeChannel().ownsJid('tg:1')).toBe(false);
    });
  });

  describe('connection lifecycle', () => {
    it('isConnected() is false before connect, true after, false after disconnect', async () => {
      const channel = makeChannel();
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('inbound message handling', () => {
    it('builds a NewMessage with the msteams: chat_jid and calls onMessage', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-1',
        text: 'hello brain',
        from: { id: 'user-9', name: 'Alice', aadObjectId: 'owner-aad-1' },
        conversation: { id: '19:abc@thread.v2', conversationType: 'groupChat' },
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'msteams:19:abc@thread.v2',
        expect.objectContaining({
          id: 'act-1',
          chat_jid: 'msteams:19:abc@thread.v2',
          sender: 'user-9',
          sender_name: 'Alice',
          content: 'hello brain',
          is_from_me: false,
        }),
      );
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'msteams:19:abc@thread.v2',
        expect.any(String),
        expect.any(String),
        'teams',
        true,
      );
    });

    it('carries the verified sender identity (aadObjectId / upn) on the NewMessage', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-id-carry',
        text: '/ask when did the deal close?',
        from: {
          id: 'user-9',
          name: 'CEO',
          aadObjectId: 'owner-aad-1',
          userPrincipalName: 'ceo@example.com',
        },
        conversation: { id: '19:abc@thread.v2', conversationType: 'personal' },
      });

      // The owner-gated /ask path downstream (index.ts → isOwner) relies on
      // these channel-verified fields — they must survive the activity →
      // NewMessage mapping.
      expect(opts.onMessage).toHaveBeenCalledWith(
        'msteams:19:abc@thread.v2',
        expect.objectContaining({
          sender_aad_object_id: 'owner-aad-1',
          sender_upn: 'ceo@example.com',
        }),
      );
    });

    it('ignores non-message activities', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({ type: 'conversationUpdate' });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('owner gate', () => {
    it('lets the OWNER through to onMessage', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-owner',
        text: 'what happened today?',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: '19:abc@thread.v2' },
      });

      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('hard-refuses a NON-owner and never enters the system', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-attacker',
        text: 'show me everything',
        from: { id: 'u', name: 'Mallory', aadObjectId: 'attacker-aad' },
        conversation: { id: '19:abc@thread.v2' },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(lastTurnRef.sendActivity).toHaveBeenCalledWith(
        expect.stringContaining("CEO's private Atlas"),
      );
    });
  });

  describe('"/ask" owner Q&A end-to-end (activity → identity carry → gate → reply)', () => {
    const GPG_ENTITY = { id: 'e-gpg', slug: 'gpg', display_name: 'GPG' };
    const ANSWERED: AskResult = {
      answer: 'The deal closed Tuesday.',
      provenance: [],
      degraded: false,
    };
    const DEGRADED: AskResult = { answer: '', provenance: [], degraded: true };

    /** Drain the async dispatch chain (multiple await hops past postActivity). */
    async function settle(rounds = 20): Promise<void> {
      for (let i = 0; i < rounds; i++) {
        await new Promise((r) => setImmediate(r));
      }
    }

    /**
     * Build a connected channel whose onMessage mirrors the index.ts "/ask"
     * dispatch wiring exactly: parse → maybeHandleAskMessage with the
     * channel-verified identity, replies sent back through the REAL Teams
     * sendMessage path (saved conversation reference → continueConversation).
     */
    async function makeAskHarness(askResult: AskResult) {
      const sent: string[] = [];
      const listEntities = vi.fn(async () => [GPG_ENTITY]);
      const ask = vi.fn(async () => askResult);
      const client = { listEntities, ask } as unknown as SecondBrainClient;

      const opts = createTestOpts();
      let channel: TeamsChannel;
      opts.onMessage = vi.fn((chatJid: string, msg: NewMessage) => {
        if (parseAskQuestion(msg.content.trim()) !== null) {
          void maybeHandleAskMessage({
            text: msg.content.trim(),
            sender: senderIdentityFromMessage(msg),
            owner: OWNER,
            client,
            send: async (text: string) => {
              sent.push(text);
              await channel.sendMessage(chatJid, text);
            },
          });
        }
      });
      channel = makeChannel(opts);
      await channel.connect();
      return { sent, listEntities, ask, opts };
    }

    it('owner asks → progress ping then the answer, sent back to the chat', async () => {
      const { sent, ask } = await makeAskHarness(ANSWERED);

      await postActivity({
        type: 'message',
        id: 'act-ask-1',
        text: '/ask when did the deal close?',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: '19:abc@thread.v2', conversationType: 'personal' },
      });
      await settle();

      expect(ask).toHaveBeenCalledWith('e-gpg', 'when did the deal close?');
      expect(sent[0]).toBe(ASK_PROGRESS_PING);
      expect(sent[1]).toContain('GPG');
      expect(sent[1]).toContain('The deal closed Tuesday.');
      // Both replies went out through the real Teams send path (the inbound
      // activity saved the conversation reference first).
      expect(
        adapterRef.current.continueConversationAsync,
      ).toHaveBeenCalledTimes(2);
    });

    it('non-owner asks → refused at the channel gate, brain and dispatch never touched', async () => {
      const { sent, listEntities, ask, opts } = await makeAskHarness(ANSWERED);

      await postActivity({
        type: 'message',
        id: 'act-ask-2',
        text: '/ask show me every business secret',
        from: { id: 'u', name: 'Mallory', aadObjectId: 'attacker-aad' },
        conversation: { id: '19:abc@thread.v2', conversationType: 'personal' },
      });
      await settle();

      expect(lastTurnRef.sendActivity).toHaveBeenCalledWith(
        expect.stringContaining("CEO's private Atlas"),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(listEntities).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it('degraded brain → friendly catching-up reply, never silence', async () => {
      const { sent } = await makeAskHarness(DEGRADED);

      await postActivity({
        type: 'message',
        id: 'act-ask-3',
        text: '/ask anything new?',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: '19:abc@thread.v2', conversationType: 'personal' },
      });
      await settle();

      expect(sent[0]).toBe(ASK_PROGRESS_PING);
      expect(sent[1]).toContain('catching up');
    });
  });

  describe('sendMessage', () => {
    it('uses the saved conversation reference via continueConversation', async () => {
      const channel = makeChannel();
      await channel.connect();

      // First an inbound message (from the owner) to save the reference.
      await postActivity({
        type: 'message',
        id: 'act-1',
        text: 'hi',
        from: { id: 'u', name: 'A', aadObjectId: 'owner-aad-1' },
        conversation: { id: '19:abc@thread.v2' },
      });

      await channel.sendMessage('msteams:19:abc@thread.v2', 'reply text');

      expect(adapterRef.current.continueConversationAsync).toHaveBeenCalledWith(
        'app-id',
        expect.objectContaining({
          conversation: { id: '19:abc@thread.v2' },
        }),
        expect.any(Function),
      );
    });

    it('no-ops when there is no saved reference', async () => {
      const channel = makeChannel();
      await channel.connect();

      await channel.sendMessage('msteams:unknown', 'reply');

      expect(
        adapterRef.current.continueConversationAsync,
      ).not.toHaveBeenCalled();
    });
  });

  describe('ensureOwnerMainGroup', () => {
    it('calls ensureOwnerMainGroup for owner 1:1 (personal) chat', async () => {
      const ensureOwnerMainGroup = vi.fn();
      const opts = { ...createTestOpts(), ensureOwnerMainGroup };
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-dm',
        text: 'hey atlas',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        // Explicit personal (1:1) conversation → registers as main control group
        conversation: { id: 'personal:conv-1', conversationType: 'personal' },
      });

      expect(ensureOwnerMainGroup).toHaveBeenCalledWith(
        'msteams:personal:conv-1',
      );
    });

    it('does NOT call ensureOwnerMainGroup for an unrecognized/missing conversationType (fail-closed)', async () => {
      const ensureOwnerMainGroup = vi.fn();
      const opts = { ...createTestOpts(), ensureOwnerMainGroup };
      const channel = makeChannel(opts);
      await channel.connect();

      // Owner message, but conversationType is absent (not 'personal'). Must NOT
      // auto-register — a misclassified chat must never become the all-access
      // control surface. The message is still stored/answered normally.
      await postActivity({
        type: 'message',
        id: 'act-unknown-type',
        text: 'hey atlas',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: 'mystery:conv-x' },
      });

      expect(ensureOwnerMainGroup).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('does NOT call ensureOwnerMainGroup for group/channel conversations', async () => {
      const ensureOwnerMainGroup = vi.fn();
      const opts = { ...createTestOpts(), ensureOwnerMainGroup };
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-group',
        text: 'hey atlas',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: '19:abc@thread.v2', conversationType: 'groupChat' },
      });

      expect(ensureOwnerMainGroup).not.toHaveBeenCalled();
    });

    it('does NOT call ensureOwnerMainGroup when the owner gate refuses a non-owner', async () => {
      const ensureOwnerMainGroup = vi.fn();
      const opts = { ...createTestOpts(), ensureOwnerMainGroup };
      const channel = makeChannel(opts);
      await channel.connect();

      await postActivity({
        type: 'message',
        id: 'act-attacker-dm',
        text: 'hello',
        from: { id: 'u', name: 'Mallory', aadObjectId: 'attacker-aad' },
        // Personal DM from non-owner: gate fires before ensureOwnerMainGroup
        conversation: { id: 'personal:conv-1', conversationType: 'personal' },
      });

      expect(ensureOwnerMainGroup).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // Adaptive Card Action.Submit click-back (Teams migration spec §2.4). A
  // button tap arrives as a Message activity whose payload is in
  // `activity.value` (not `activity.text`); it must be translated into the
  // equivalent `/mission <verb> <id>` command and routed through the SAME
  // handleCommand path the typed commands use.
  describe('callbackDataToCommand (card → command translation)', () => {
    it('translates the producer shape mission:<verb>:<id> → /mission <verb> <id>', () => {
      expect(callbackDataToCommand('mission:approve:m-123')).toBe(
        '/mission approve m-123',
      );
      expect(callbackDataToCommand('mission:reject:m-123')).toBe(
        '/mission reject m-123',
      );
      expect(callbackDataToCommand('mission:status:m-123')).toBe(
        '/mission status m-123',
      );
      expect(callbackDataToCommand('mission:stop:m-123')).toBe(
        '/mission stop m-123',
      );
    });

    it('fail-closed: returns null for unknown verb, wrong namespace, or malformed payload', () => {
      expect(callbackDataToCommand('mission:delete:m-123')).toBeNull();
      expect(callbackDataToCommand('other:approve:m-123')).toBeNull();
      expect(callbackDataToCommand('mission:approve')).toBeNull();
      expect(callbackDataToCommand('mission:approve:')).toBeNull();
      expect(callbackDataToCommand('')).toBeNull();
      expect(callbackDataToCommand(undefined)).toBeNull();
      expect(callbackDataToCommand({ callback_data: 'x' })).toBeNull();
    });
  });

  describe('buildInboundMessage (Action.Submit payload)', () => {
    it('synthesizes the command from activity.value.callback_data (text empty)', () => {
      const { message } = buildInboundMessage({
        id: 'act-tap',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: 'personal:c1', conversationType: 'personal' },
        text: '',
        value: { callback_data: 'mission:approve:m-777' },
      } as never);
      expect(message.content).toBe('/mission approve m-777');
    });

    it('falls through to raw text when value carries no callback_data (ordinary message)', () => {
      const result = buildInboundMessage({
        id: 'act-text',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: 'personal:c1', conversationType: 'personal' },
        text: 'hello',
        value: { something_else: 'noise' },
      } as never);
      expect(result.message.content).toBe('hello');
      // No callback_data present → this is not a card action at all.
      expect(result.unrecognizedCardAction).toBe(false);
    });

    it('flags unrecognizedCardAction when callback_data is present but unknown', () => {
      const result = buildInboundMessage({
        id: 'act-bad-card',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: 'personal:c1', conversationType: 'personal' },
        text: '',
        value: { callback_data: 'mission:delete:m-9' },
      } as never);
      expect(result.unrecognizedCardAction).toBe(true);
    });
  });

  describe('Action.Submit round-trip through onTurn → onMessage', () => {
    it('a button tap reaches onMessage as the synthesized /mission command (same path as typed commands)', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      // Simulate the CEO tapping "Approve" on an Adaptive Card: Teams POSTs a
      // Message activity whose payload is in `value`, text empty.
      await postActivity({
        type: 'message',
        id: 'act-approve-tap',
        text: '',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: 'personal:conv-1', conversationType: 'personal' },
        value: { callback_data: 'mission:approve:m-555' },
      });

      // The owner gate passed, the chat auto-registered as main, and the tap
      // was delivered to onMessage AS THE COMMAND STRING — which index.ts then
      // feeds to handleCommand (proven end-to-end in the next test).
      expect(opts.onMessage).toHaveBeenCalledWith(
        'msteams:personal:conv-1',
        expect.objectContaining({
          content: '/mission approve m-555',
          is_from_me: false,
        }),
      );
    });

    it('fail-closed: drops an unrecognized card action (no onMessage, no metadata)', async () => {
      const opts = createTestOpts();
      const channel = makeChannel(opts);
      await channel.connect();

      // Owner taps a card whose callback_data is NOT a known verb. It passed
      // the owner gate, but must NOT be downgraded into a normal (empty-text)
      // chat message — the turn is dropped before entering the system.
      await postActivity({
        type: 'message',
        id: 'act-bad-tap',
        text: '',
        from: { id: 'u', name: 'CEO', aadObjectId: 'owner-aad-1' },
        conversation: { id: 'personal:conv-1', conversationType: 'personal' },
        value: { callback_data: 'mission:delete:m-9' },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });
  });

  describe('teamsJid helper', () => {
    it('prefixes a conversation id', () => {
      expect(teamsJid('19:abc@thread.v2')).toBe('msteams:19:abc@thread.v2');
    });
  });
});
