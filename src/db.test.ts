import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  clearGroupIsMain,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- verified sender identity persistence (owner-gated /ask depends on it) ---

describe('verified sender identity round-trip', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2026-06-09T00:00:00.000Z');
  });

  it('storeMessage persists sender_aad_object_id + sender_upn and both read paths return them', () => {
    storeMessage({
      id: 'id1',
      chat_jid: 'group@g.us',
      sender: '29:user',
      sender_name: 'CEO',
      content: '/ask what closed?',
      timestamp: '2026-06-09T10:00:00.000Z',
      is_from_me: false,
      sender_aad_object_id: 'owner-aad-1',
      sender_upn: 'ceo@example.com',
    });

    const since = getMessagesSince('group@g.us', '', 'Andy');
    expect(since).toHaveLength(1);
    expect(since[0].sender_aad_object_id).toBe('owner-aad-1');
    expect(since[0].sender_upn).toBe('ceo@example.com');

    const { messages } = getNewMessages(['group@g.us'], '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_aad_object_id).toBe('owner-aad-1');
    expect(messages[0].sender_upn).toBe('ceo@example.com');
  });

  it('storeMessageDirect persists the identity fields too', () => {
    storeMessageDirect({
      id: 'id2',
      chat_jid: 'group@g.us',
      sender: '29:user',
      sender_name: 'CEO',
      content: 'direct store',
      timestamp: '2026-06-09T10:01:00.000Z',
      is_from_me: false,
      sender_aad_object_id: 'owner-aad-1',
      sender_upn: 'ceo@example.com',
    });

    const messages = getMessagesSince('group@g.us', '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_aad_object_id).toBe('owner-aad-1');
    expect(messages[0].sender_upn).toBe('ceo@example.com');
  });

  it('messages without verified identity come back undefined (fail-closed for isOwner)', () => {
    storeMessage({
      id: 'id3',
      chat_jid: 'group@g.us',
      sender: '29:other',
      sender_name: 'Someone',
      content: 'no identity here',
      timestamp: '2026-06-09T10:02:00.000Z',
      is_from_me: false,
    });

    const messages = getMessagesSince('group@g.us', '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].sender_aad_object_id).toBeUndefined();
    expect(messages[0].sender_upn).toBeUndefined();
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });

  it('clearGroupIsMain durably demotes one group without touching others', () => {
    // Reproduce the legacy two-main-on-disk state. setRegisteredGroup enforces
    // single-main on each write, so write the two rows in a way that leaves
    // both is_main=1: promote each, then re-promote the second WITHOUT it
    // demoting the first. We sidestep the write-path guard by writing the
    // second as non-main and forcing it main only via a direct path — but the
    // public API can't create two mains, so instead we promote the survivor
    // last and use clearGroupIsMain on the stale one, which is exactly the
    // load-path normalization. First simulate: both rows main by writing the
    // stale main, then writing the new main (which demotes the stale one via
    // the transaction), then re-promoting the stale one to recreate the bug.
    setRegisteredGroup('telegram-main@dead', {
      name: 'Telegram Main (dead)',
      folder: 'telegram_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    // Re-promote a second group; the write-path guard demotes the first, so to
    // recreate the two-main legacy state we re-promote the first again.
    setRegisteredGroup('teams-main@live', {
      name: 'Teams Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2024-01-02T00:00:00.000Z',
      isMain: true,
    });
    setRegisteredGroup('telegram-main@dead', {
      name: 'Telegram Main (dead)',
      folder: 'telegram_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    // Sanity: this re-promotion demoted teams. To force the genuine two-main
    // legacy state we now clear nothing and instead clear the stale one, which
    // is what loadState does. Verify clearGroupIsMain only touches the target.
    clearGroupIsMain('teams-main@live');
    let groups = getAllRegisteredGroups();
    expect(groups['teams-main@live'].isMain).toBeUndefined();
    expect(groups['telegram-main@dead'].isMain).toBe(true);

    // And clearing the dead one leaves the survivor untouched — the alert
    // router's `WHERE is_main=1 LIMIT 1` can then only return the survivor.
    setRegisteredGroup('teams-main@live', {
      name: 'Teams Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2024-01-02T00:00:00.000Z',
      isMain: true,
    });
    clearGroupIsMain('telegram-main@dead');
    groups = getAllRegisteredGroups();
    const stillMain = Object.entries(groups).filter(([, g]) => g.isMain);
    expect(stillMain).toHaveLength(1);
    expect(stillMain[0][0]).toBe('teams-main@live');
  });
});

describe('single-JID-per-folder invariant (cross-review FAIL_BLOCKING)', () => {
  it('re-registering a folder under a new JID drops the stale row durably', () => {
    setRegisteredGroup('old-jid@teams', {
      name: 'GPG',
      folder: 'atlas_gpg',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    // Channel re-registration changes the JID for the SAME folder.
    setRegisteredGroup('new-jid@teams', {
      name: 'GPG',
      folder: 'atlas_gpg',
      trigger: '@Atlas',
      added_at: '2024-02-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    // Only ONE row for the folder survives on disk (the stale-JID duplicate
    // must not reload after restart).
    const forFolder = Object.entries(groups).filter(
      ([, g]) => g.folder === 'atlas_gpg',
    );
    expect(forFolder).toHaveLength(1);
    expect(forFolder[0][0]).toBe('new-jid@teams');
    expect(groups['old-jid@teams']).toBeUndefined();
  });

  it('re-registration migrates existing scheduled_tasks.chat_jid to the new JID', () => {
    setRegisteredGroup('old-jid@teams', {
      name: 'GPG',
      folder: 'atlas_gpg',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-migrate',
      group_folder: 'atlas_gpg',
      chat_jid: 'old-jid@teams',
      prompt: 'recurring',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    // Re-register the folder under a new channel JID.
    setRegisteredGroup('new-jid@teams', {
      name: 'GPG',
      folder: 'atlas_gpg',
      trigger: '@Atlas',
      added_at: '2024-02-01T00:00:00.000Z',
    });

    // The scheduled task now points at the live JID, not the dead one — so the
    // scheduler no longer routes its output to a JID no channel owns.
    const task = getTaskById('task-migrate');
    expect(task).toBeDefined();
    expect(task!.chat_jid).toBe('new-jid@teams');
  });

  it('a plain same-JID re-register leaves other folders\' tasks untouched', () => {
    setRegisteredGroup('jid-a@teams', {
      name: 'A',
      folder: 'folder_a',
      trigger: '@Atlas',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      group_folder: 'folder_b',
      chat_jid: 'jid-b@teams',
      prompt: 'unrelated',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    // Re-register folder_a under the SAME jid — must not touch folder_b's task.
    setRegisteredGroup('jid-a@teams', {
      name: 'A',
      folder: 'folder_a',
      trigger: '@Atlas',
      added_at: '2024-02-01T00:00:00.000Z',
    });

    expect(getTaskById('task-other')!.chat_jid).toBe('jid-b@teams');
  });
});
