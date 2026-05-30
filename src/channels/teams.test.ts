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

import { TeamsChannel, teamsJid } from './teams.js';
import type { ChannelOpts } from './registry.js';

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

  describe('teamsJid helper', () => {
    it('prefixes a conversation id', () => {
      expect(teamsJid('19:abc@thread.v2')).toBe('msteams:19:abc@thread.v2');
    });
  });
});
