import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { isKnownUndeliverableJid } from './router.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      sender_aad_object_id TEXT,
      sender_upn TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    -- Mission state (single source of truth per Codex architecture review)
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      template_type TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      roster TEXT,
      cost_estimate_usd REAL,
      cost_actual_usd REAL DEFAULT 0,
      correlation_id TEXT,
      paperclip_issue_id TEXT,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      result_summary TEXT,
      chain_parent_id TEXT,
      FOREIGN KEY (chain_parent_id) REFERENCES missions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    CREATE INDEX IF NOT EXISTS idx_missions_entity ON missions(entity);

    -- Per-role state within a mission
    CREATE TABLE IF NOT EXISTS mission_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      role_name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'sonnet',
      task TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      container_name TEXT,
      started_at TEXT,
      completed_at TEXT,
      cost_usd REAL DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      output_path TEXT,
      error TEXT,
      FOREIGN KEY (mission_id) REFERENCES missions(id),
      UNIQUE(mission_id, role_name)
    );
    CREATE INDEX IF NOT EXISTS idx_mission_roles_mission ON mission_roles(mission_id);

    -- Mission event log (append-only audit trail)
    CREATE TABLE IF NOT EXISTS mission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      role_name TEXT,
      details TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES missions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mission_events_mission ON mission_events(mission_id);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add verified-sender identity columns if they don't exist (migration for
  // existing DBs). Nullable on purpose: only channels that authenticate the
  // sender (Teams) populate them; old rows and identity-less transports stay
  // NULL, which keeps the owner gate fail-closed for replayed messages.
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN sender_aad_object_id TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN sender_upn TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    // Historical data migration: relabels legacy `tg:%` rows that predate the
    // channel column. The Telegram channel itself was retired 2026-06-03 (Teams
    // is now primary); this backfill is kept only so old rows stay queryable.
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, sender_aad_object_id, sender_upn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.sender_aad_object_id ?? null,
    msg.sender_upn ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  sender_aad_object_id?: string;
  sender_upn?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, sender_aad_object_id, sender_upn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.sender_aad_object_id ?? null,
    msg.sender_upn ?? null,
  );
}

/**
 * Map raw message rows to NewMessage. SQLite returns NULL for the nullable
 * verified-identity columns; NewMessage declares them as optional strings, so
 * normalize NULL → undefined (isOwner treats both as "unverified" — the gate
 * stays fail-closed either way, this just keeps the type contract honest).
 */
function normalizeMessageRows(rows: unknown[]): NewMessage[] {
  return (
    rows as Array<
      NewMessage & {
        sender_aad_object_id: string | null;
        sender_upn: string | null;
      }
    >
  ).map((row) => ({
    ...row,
    sender_aad_object_id: row.sender_aad_object_id ?? undefined,
    sender_upn: row.sender_upn ?? undefined,
  }));
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             sender_aad_object_id, sender_upn
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = normalizeMessageRows(
    db.prepare(sql).all(lastTimestamp, ...jids, `${botPrefix}:%`, limit),
  );

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             sender_aad_object_id, sender_upn
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return normalizeMessageRows(
    db.prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit),
  );
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  let containerConfig: RegisteredGroup['containerConfig'] | undefined;
  if (row.container_config) {
    try {
      containerConfig = JSON.parse(row.container_config);
    } catch {
      logger.error(
        { jid: row.jid, raw: row.container_config.slice(0, 100) },
        'Corrupted container_config JSON — ignoring config for this group',
      );
    }
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  // Write-layer main-group invariant (al22 reland spec, commit-review round
  // 1 finding 2): a knowably-undeliverable JID (logical `dispatch:` alias,
  // retired channel) can NEVER be stored as is_main. Main-group identity
  // routes CEO alerts and authorizes privileged IPC; every runtime mirror
  // (selectLiveMain here, host/host-executor.py, scripts/create-group.sh)
  // skips such rows on the READ side, so persisting one as main would at
  // best be ignored and at worst (a stale mirror) black-hole alerts. No
  // production caller passes such a JID with isMain — channel registration
  // and ensureOwnerMainGroup only promote live channel JIDs — so this throw
  // is an invariant backstop, same contract as the invalid-folder throw
  // above. Tests simulating LEGACY pre-invariant rows seed them with
  // _setGroupIsMainUnchecked instead.
  if (group.isMain && isKnownUndeliverableJid(jid)) {
    throw new Error(
      `Cannot register ${jid} as main group: JID shape is knowably ` +
        `undeliverable (logical alias or retired channel)`,
    );
  }
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Enforce the single-main invariant. Alert routing reads
  // `WHERE is_main=1 LIMIT 1`, so two main rows (e.g. a legacy Telegram main
  // left behind after the Teams migration) could silently route alerts to a
  // channel that no longer exists. Demote every other row before promoting
  // this one, atomically, so at most one main can exist.
  const apply = db.transaction(() => {
    // Same-JID FOLDER-RENAME migration (codex 66873e9 soft finding): the
    // upsert below is keyed by JID, so re-registering an existing JID under
    // a DIFFERENT folder moves the group row — but scheduled_tasks rows stay
    // keyed to the OLD folder, which after this write has no registered
    // group. task-scheduler resolves tasks by group_folder, so those tasks
    // would error "Group not found" on every retry, forever. Migrate them to
    // the new folder FIRST (the chat_jid repoint below then also covers
    // them). The old folder's sessions row is DELETED, not migrated: the
    // on-disk session transcripts live under data/sessions/<oldFolder>/
    // .claude, which the new folder's container does not mount — a migrated
    // session_id would fail SDK resume, and a row left behind would hand the
    // old conversation to whatever group registers at the vacated folder
    // next (cross-group context leak).
    const priorRow = db
      .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
      .get(jid) as { folder: string } | undefined;
    if (priorRow && priorRow.folder !== group.folder) {
      db.prepare(
        'UPDATE scheduled_tasks SET group_folder = ? WHERE group_folder = ?',
      ).run(group.folder, priorRow.folder);
      db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(
        priorRow.folder,
      );
    }
    if (group.isMain) {
      db.prepare('UPDATE registered_groups SET is_main = 0 WHERE jid != ?').run(
        jid,
      );
    }
    // Durably enforce the single-JID-per-folder invariant (cross-review
    // FAIL_BLOCKING, src/index.ts:304-338). registerGroup()'s in-memory
    // pruning deletes a re-registered folder's stale JID from RAM only; the
    // upsert here is keyed by JID, so a prior row for the SAME folder under a
    // DIFFERENT JID survives on disk. After a restart loadState() reloads both
    // rows from getAllRegisteredGroups(), re-introducing the stale-JID
    // duplicate that folder-based resolution (resolveCallbackJid / dispatch
    // target rewriting) can once again pick. Delete any other row for this
    // folder before upserting so the DB holds exactly one current JID per
    // folder, matching the in-memory contract.
    db.prepare(
      'DELETE FROM registered_groups WHERE folder = ? AND jid != ?',
    ).run(group.folder, jid);
    // Migrate dependent scheduled_tasks rows in the SAME write (cross-review
    // FAIL_BLOCKING round 2, src/task-scheduler.ts:199-223,295-300):
    // scheduled_tasks.chat_jid is captured at creation time and nothing else
    // rewrites it. When a folder's channel JID changes (re-registration), the
    // scheduler would keep routing container output, result delivery, idle
    // tracking, and auto-pause escalation to the now-dead old JID
    // ("No channel owns JID"). Repoint this folder's tasks at the current JID
    // so the strengthened single-JID-per-folder invariant stays consistent
    // end-to-end. Constrained to rows that don't already match, so a plain
    // re-register of the same JID is a no-op.
    //
    // Deliverability guard (al22 reland spec pre-review finding 1): this is
    // a writer of scheduled_tasks.chat_jid, so it must honor the shared
    // deliverability contract. Registering a folder under a knowably-
    // undeliverable JID (e.g. a bridge `dispatch:{folder}` logical row) must
    // not repoint existing task rows at a target no outbound channel can
    // ever own — tasks keep their last channel JID instead. The group row
    // itself still registers (logical rows are legitimate); only the
    // task-row rewrite is gated.
    if (!isKnownUndeliverableJid(jid)) {
      db.prepare(
        'UPDATE scheduled_tasks SET chat_jid = ? WHERE group_folder = ? AND chat_jid != ?',
      ).run(jid, group.folder, jid);
    }
    upsert.run(
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
      group.isMain ? 1 : 0,
    );
  });
  apply();
}

/**
 * Durably clear the is_main flag for a single group, without touching any other
 * row. Used by the load-path single-main normalization (see loadState in
 * index.ts): when two legacy is_main=1 rows survive (e.g. a Telegram main left
 * behind after the Teams migration), the demotion must be persisted — otherwise
 * the DB keeps both main rows and the alert router's
 * `SELECT jid ... WHERE is_main = 1 LIMIT 1` can route alerts to a dead target
 * after every restart. Unlike setRegisteredGroup, this does NOT promote any row
 * or demote others; it only clears the named jid.
 */
export function clearGroupIsMain(jid: string): void {
  db.prepare('UPDATE registered_groups SET is_main = 0 WHERE jid = ?').run(jid);
}

/**
 * @internal - for tests ONLY. Flip is_main=1 on an existing row WITHOUT the
 * setRegisteredGroup write-layer invariants, simulating LEGACY data that
 * predates them (e.g. the retired Telegram main row from the 2026-06-11
 * incident, which real VPS DBs contained). Production code must never call
 * this — go through setRegisteredGroup.
 */
export function _setGroupIsMainUnchecked(jid: string): void {
  db.prepare('UPDATE registered_groups SET is_main = 1 WHERE jid = ?').run(jid);
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    let containerConfig: RegisteredGroup['containerConfig'] | undefined;
    if (row.container_config) {
      try {
        containerConfig = JSON.parse(row.container_config);
      } catch {
        // Corrupted JSON — log and skip config (don't crash the entire process)
        logger.error(
          { jid: row.jid, raw: row.container_config.slice(0, 100) },
          'Corrupted container_config JSON — ignoring config for this group',
        );
      }
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Mission accessors ---

export interface MissionRow {
  id: string;
  entity: string;
  template_type: string;
  title: string;
  brief: string | null;
  status: string;
  roster: string | null;
  cost_estimate_usd: number | null;
  cost_actual_usd: number;
  correlation_id: string | null;
  paperclip_issue_id: string | null;
  created_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_summary: string | null;
  chain_parent_id: string | null;
}

export interface MissionRoleRow {
  id: number;
  mission_id: string;
  role_name: string;
  model: string;
  task: string | null;
  status: string;
  container_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  output_path: string | null;
  error: string | null;
}

/**
 * Generate a collision-resistant mission ID.
 * Single source of truth — used by both /mission create and IPC create_mission.
 */
export function generateMissionId(): string {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createMission(mission: {
  id: string;
  entity: string;
  template_type: string;
  title: string;
  brief?: string;
  roster?: string;
  cost_estimate_usd?: number;
  correlation_id?: string;
}): void {
  db.prepare(
    `INSERT INTO missions (id, entity, template_type, title, brief, roster, cost_estimate_usd, correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mission.id,
    mission.entity,
    mission.template_type,
    mission.title,
    mission.brief ?? null,
    mission.roster ?? null,
    mission.cost_estimate_usd ?? null,
    mission.correlation_id ?? null,
    new Date().toISOString(),
  );
}

export function getMission(id: string): MissionRow | undefined {
  return db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as
    | MissionRow
    | undefined;
}

export function getMissionByPrefix(prefix: string): MissionRow | undefined {
  return db
    .prepare(
      'SELECT * FROM missions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(`${prefix}%`) as MissionRow | undefined;
}

export function updateMission(
  id: string,
  updates: Partial<
    Pick<
      MissionRow,
      | 'status'
      | 'approved_at'
      | 'started_at'
      | 'completed_at'
      | 'result_summary'
      | 'cost_actual_usd'
      | 'paperclip_issue_id'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE missions SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getActiveMissions(): MissionRow[] {
  return db
    .prepare(
      `SELECT * FROM missions WHERE status IN ('proposed', 'approved', 'running', 'synthesizing')
       ORDER BY created_at DESC`,
    )
    .all() as MissionRow[];
}

export function getRecentMissions(limit: number = 20): MissionRow[] {
  return db
    .prepare('SELECT * FROM missions ORDER BY created_at DESC LIMIT ?')
    .all(limit) as MissionRow[];
}

export function createMissionRole(role: {
  mission_id: string;
  role_name: string;
  model: string;
  task?: string;
}): void {
  db.prepare(
    `INSERT INTO mission_roles (mission_id, role_name, model, task)
     VALUES (?, ?, ?, ?)`,
  ).run(role.mission_id, role.role_name, role.model, role.task || null);
}

export function getMissionRoles(missionId: string): MissionRoleRow[] {
  return db
    .prepare('SELECT * FROM mission_roles WHERE mission_id = ? ORDER BY id')
    .all(missionId) as MissionRoleRow[];
}

export function updateMissionRole(
  missionId: string,
  roleName: string,
  updates: Partial<
    Pick<
      MissionRoleRow,
      | 'status'
      | 'container_name'
      | 'started_at'
      | 'completed_at'
      | 'cost_usd'
      | 'input_tokens'
      | 'output_tokens'
      | 'output_path'
      | 'error'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(missionId, roleName);
  db.prepare(
    `UPDATE mission_roles SET ${fields.join(', ')} WHERE mission_id = ? AND role_name = ?`,
  ).run(...values);
}

export function logMissionEvent(
  missionId: string,
  eventType: string,
  roleName?: string,
  details?: string,
): void {
  db.prepare(
    `INSERT INTO mission_events (mission_id, event_type, role_name, details, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    missionId,
    eventType,
    roleName || null,
    details || null,
    new Date().toISOString(),
  );
}

export function getMissionEvents(missionId: string): Array<{
  event_type: string;
  role_name: string | null;
  details: string | null;
  timestamp: string;
}> {
  return db
    .prepare(
      'SELECT event_type, role_name, details, timestamp FROM mission_events WHERE mission_id = ? ORDER BY timestamp',
    )
    .all(missionId) as Array<{
    event_type: string;
    role_name: string | null;
    details: string | null;
    timestamp: string;
  }>;
}

/** Count missions with given status, optionally filtered by entity */
export function countMissionsByStatus(status: string, entity?: string): number {
  if (entity) {
    const row = db
      .prepare(
        'SELECT COUNT(*) as cnt FROM missions WHERE status = ? AND entity = ?',
      )
      .get(status, entity) as { cnt: number };
    return row.cnt;
  }
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM missions WHERE status = ?')
    .get(status) as { cnt: number };
  return row.cnt;
}

// --- JSON migration ---

/**
 * Normalize a LEGACY registered-group row at JSON->SQLite migration time.
 *
 * Legacy undeliverable MAIN rows (e.g. a tg: main from before the Telegram
 * retirement, or a hand-edited dispatch: alias) predate the
 * setRegisteredGroup write-layer invariant; funneling one through it
 * unchanged would throw, and migrateJsonState's generic catch would then
 * silently DROP the row — a destructive upgrade path (codex e6dde1a
 * finding 1). Instead the row migrates as NON-main: identical end state to
 * what loadState's single-live-main normalization would produce for it, with
 * no registration data lost. Returns the input object unchanged (same
 * reference) when no normalization is needed, so the caller can detect and
 * log the demotion.
 *
 * Exported for tests — migrateJsonState itself is fs-driven (DATA_DIR) and
 * not unit-testable in isolation.
 */
export function normalizeLegacyMigratedGroup(
  jid: string,
  group: RegisteredGroup,
): RegisteredGroup {
  if (group.isMain && isKnownUndeliverableJid(jid)) {
    return { ...group, isMain: undefined };
  }
  return group;
}

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        const normalized = normalizeLegacyMigratedGroup(jid, group);
        if (normalized !== group) {
          logger.warn(
            { jid, folder: group.folder },
            'Migrating legacy undeliverable main row as NON-main (retired/alias JID cannot hold the main role)',
          );
        }
        setRegisteredGroup(jid, normalized);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
