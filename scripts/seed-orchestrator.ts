#!/usr/bin/env tsx
/**
 * Seed the daily 6AM orchestrator scheduled task into NanoClaw's database.
 *
 * Usage:
 *   tsx scripts/seed-orchestrator.ts [--chat-jid <jid>] [--force]
 *
 * Defaults:
 *   --chat-jid: reads from registered_groups where is_main=1 (live main).
 *     An explicit JID must itself be a registered group on a LIVE (non-
 *     retired) channel — the task's group_folder is resolved from its row,
 *     never assumed, and a retired-channel JID is rejected outright.
 *   --force: fully replace the existing orchestrator task (routing included)
 *
 * Run this on the VPS after Phase 3 deploy, or locally for testing.
 */

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { isRetiredChannelJid, selectLiveMain } from '../src/router.js';

const TASK_ID = 'atlas-orchestrator-daily';
const SCHEDULE_TYPE = 'cron';
const SCHEDULE_VALUE = '0 6 * * *'; // 6AM daily
const TIMEZONE = process.env.TZ || 'America/New_York';

const ORCHESTRATOR_PROMPT = `[ORCHESTRATOR — Daily Morning Digest]

You are Atlas running the daily 6AM orchestrator task. Your job: gather system state
across all entities and produce a concise morning briefing for the CEO via Teams.

*Step 1: Preflight* (governance module handles this — if you're reading this, you passed)

*Step 2: Gather data*

Read these files and summarize what you find:

1. Mode: /workspace/extra/atlas-state/state/mode.json
2. Graduation: /workspace/extra/atlas-state/autonomy/graduation-status.json
3. Quota: /workspace/extra/atlas-state/autonomy/quota-tracking.jsonl (today's entries)
4. Learning log: /workspace/extra/atlas-state/autonomy/learning-log.jsonl (last 24h)
5. Approval queue: list files in /workspace/extra/atlas-state/approval-queue/pending/
6. Audit logs: /workspace/extra/atlas-state/audit/ (each entity subfolder, today's file)
7. Entity profiles: /workspace/extra/atlas-entities/ (read entity-profile.md for each)
8. Agent performance: /workspace/extra/atlas-state/agent-performance/ (if exists)
9. Evolution log: /workspace/extra/atlas-state/evolution-log.jsonl (all entries since last retro — check /workspace/extra/atlas-state/state/last-retro-marker.json for cutoff, or use last 7 days if no marker)
10. Session count: /workspace/extra/atlas-state/hook-health/session-start.jsonl (count entries in last 7 days — this is how many CEO sessions happened)
11. System health: /workspace/extra/atlas-state/state/system-health.json (check for CRITICAL or WARNING status)

If a file doesn't exist, note it briefly and move on. Don't error out.

*Quiet-log check:* Compare session count (item 10) vs evolution log entries (item 9). If 5+ sessions happened but 0 friction events were logged, flag it: "Evolution log silent during N sessions — possible logging failure." This is important because a broken stop hook produces zero friction events, making everything look healthy when enforcement is actually dead.

*Step 3: Produce the digest*

Format for chat delivery (no markdown headings — use *bold* for sections):

*Morning Briefing — {today's date}*

*Needs Your Attention*
{Pending approval items with context. Anomalies. Failures. Empty = "Nothing urgent."}

*Overnight Activity*
Sessions: {n} | Autonomous: {n} | Errors: {n}

*Entity Status*
- GPG: {healthy/watch/concern} — {1 line}
- Crownscape: {healthy/watch/concern} — {1 line}

*Graduation*
Milestone: {current} | Progress: {key metric}

*Evolution*
{n} friction events since last retro ({n} MAJOR, {n} MINOR) | {quiet-log warning if applicable}
{If 3+ events share a theme: "Recurring: {theme} ({n} times) — graduation candidate"}
{If system-health.json shows CRITICAL: "System health: CRITICAL — {detail}"}

*Quota*
{n} invocations | {weighted} weighted | {status}

*Priorities Today*
1. {Most important — specific, actionable}
2. {Second}
3. {Third}

Rules:
- Under 500 words
- Quantified — real numbers, not vague
- If data is missing, say "no data" not a paragraph explaining why
- If everything is healthy, keep it short: "All systems nominal"
- Priorities should reference actual pending work, not generic advice
`;

// --- Main ---

const args = process.argv.slice(2);
const force = args.includes('--force');
const chatJidIdx = args.indexOf('--chat-jid');
let chatJid = chatJidIdx >= 0 ? args[chatJidIdx + 1] : undefined;

// Find database
const dbPath = path.resolve('store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  console.error('Run this script from the NanoClaw project root.');
  process.exit(1);
}

const db = new Database(dbPath);

// Resolve chat_jid (and the task's group_folder) from registered groups if
// not provided. Retirement-aware: a bare `LIMIT 1` could seed the daily
// digest task against a retired-channel JID (e.g. the legacy Telegram main
// row from the 2026-06-11 trace), so every digest delivery would silently
// fail. selectLiveMain never returns a retired row. The task must also be
// seeded under the LIVE main group's folder: the scheduler resolves the
// group by `g.folder === task.group_folder` (src/task-scheduler.ts), so a
// hard-coded 'atlas_main' folder produces a permanently failing "Group not
// found" task whenever the live main lives in another folder (e.g. the VPS
// Teams main in 'atlas_teams').
let groupFolder: string;
if (!chatJid) {
  const mains = db.prepare(
    'SELECT jid, folder FROM registered_groups WHERE is_main = 1'
  ).all() as Array<{ jid: string; folder: string }>;

  const main = selectLiveMain(mains);
  if (!main) {
    console.error('No live-channel main group found in registered_groups. Provide --chat-jid.');
    process.exit(1);
  }
  chatJid = main.jid;
  groupFolder = main.folder;
  console.log(`Found main group: ${chatJid} (folder ${groupFolder})`);
} else {
  // Explicit --chat-jid: must be DELIVERABLE, not merely registered. A
  // retired-channel JID (e.g. the legacy Telegram main) can still hold a
  // registered_groups row, and the default path is retirement-aware via
  // selectLiveMain — so without this check the explicit path was the one
  // remaining way to seed a task whose runs succeed but whose digest +
  // auto-pause escalations are forwarded to a dead task.chat_jid
  // (src/task-scheduler.ts) — a permanently black-holed morning briefing
  // (codex 20924e0 finding 2).
  if (isRetiredChannelJid(chatJid)) {
    console.error(`--chat-jid ${chatJid} targets a retired channel; every digest delivery would silently fail.`);
    console.error('Pass a live registered group JID, or omit --chat-jid to use the live main.');
    process.exit(1);
  }
  // Resolve the task's group_folder from the registered row for that JID.
  // The scheduler executes a task by matching task.group_folder against the
  // registered groups' folders — NOT by chat_jid — so silently falling back
  // to a hard-coded folder here seeded a permanently failing "Group not
  // found" task whenever the JID's real folder differed (codex 6859c4f
  // finding 2). An unregistered JID is rejected outright for the same
  // reason: its task could never run.
  const row = db.prepare(
    'SELECT folder FROM registered_groups WHERE jid = ?'
  ).get(chatJid) as { folder: string } | undefined;
  if (!row) {
    console.error(`--chat-jid ${chatJid} is not in registered_groups; register the group first.`);
    console.error('(The scheduler resolves tasks by the registered group folder, so a task seeded against an unregistered JID never runs.)');
    process.exit(1);
  }
  groupFolder = row.folder;
  console.log(`Resolved group folder for ${chatJid}: ${groupFolder}`);
}

// Check if task already exists
const existing = db.prepare(
  'SELECT id, status FROM scheduled_tasks WHERE id = ?'
).get(TASK_ID) as { id: string; status: string } | undefined;

if (existing && !force) {
  console.log(`Orchestrator task already exists (status: ${existing.status}).`);
  console.log('Use --force to replace it.');
  process.exit(0);
}

// Compute next run
const interval = CronExpressionParser.parse(SCHEDULE_VALUE, { tz: TIMEZONE });
const nextRun = interval.next().toISOString();

// Upsert the task
if (existing) {
  // A --force reseed must be a TRUE replace. The point of reseeding is to
  // move the task off a stale group_folder / retired-channel chat_jid, so an
  // update that only touched prompt/schedule/next_run left the old routing
  // in place: the scheduler kept resolving the stale folder ("Group not
  // found") and any dead-channel chat_jid stayed live (codex 6859c4f
  // finding 1). Rewrite every column the INSERT sets except created_at.
  db.prepare(`
    UPDATE scheduled_tasks
    SET group_folder = ?, chat_jid = ?, prompt = ?, schedule_type = ?,
        schedule_value = ?, context_mode = ?, next_run = ?, status = 'active'
    WHERE id = ?
  `).run(
    groupFolder,
    chatJid,
    ORCHESTRATOR_PROMPT,
    SCHEDULE_TYPE,
    SCHEDULE_VALUE,
    'isolated', // Fresh context each run — no session carryover
    nextRun,
    TASK_ID,
  );
  console.log(`Updated existing orchestrator task.`);
} else {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TASK_ID,
    groupFolder,
    chatJid,
    ORCHESTRATOR_PROMPT,
    SCHEDULE_TYPE,
    SCHEDULE_VALUE,
    'isolated', // Fresh context each run — no session carryover
    nextRun,
    'active',
    new Date().toISOString(),
  );
  console.log(`Created orchestrator task.`);
}

console.log(`  ID:       ${TASK_ID}`);
console.log(`  Group:    ${groupFolder}`);
console.log(`  Chat JID: ${chatJid}`);
console.log(`  Schedule: ${SCHEDULE_VALUE} (${TIMEZONE})`);
console.log(`  Next run: ${nextRun}`);
console.log('');
console.log('Done. The orchestrator will run at 6AM daily.');

db.close();
