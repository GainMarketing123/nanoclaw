#!/usr/bin/env tsx
/**
 * Seed the daily 6AM orchestrator scheduled task into NanoClaw's database.
 *
 * Usage:
 *   tsx scripts/seed-orchestrator.ts [--chat-jid <jid>] [--force]
 *
 * Defaults:
 *   --chat-jid: the live main group (selectLiveMain over registered_groups —
 *               retirement/alias-aware, deterministic)
 *   --force: replace existing orchestrator task if one exists
 *
 * Target resolution is the shared, unit-tested resolveSeedTarget from
 * src/router.ts (al22 reland spec,
 * plans/al22-seed-orchestrator-reland-spec-2026-06-12.md): both group_folder
 * and chat_jid always come from a real registered row — the scheduler executes
 * tasks by matching task.group_folder to a registered group's folder and
 * delivers output to task.chat_jid, so a hard-coded folder or an unvalidated
 * JID seeds a task that either never runs or black-holes its digest.
 *
 * Run this on the VPS after Phase 3 deploy, or locally for testing.
 */

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { resolveSeedTarget } from '../src/router.js';

const TASK_ID = 'atlas-orchestrator-daily';
const SCHEDULE_TYPE = 'cron';
const SCHEDULE_VALUE = '0 6 * * *'; // 6AM daily
const CONTEXT_MODE = 'isolated'; // Fresh context each run — no session carryover
const TIMEZONE = process.env.TZ || 'America/New_York';

// Prompt rewritten 2026-06-12 per the briefing stale-content audit
// (~/.atlas/capture/briefing-stale-content-audit-2026-06-12.md): the previous
// generation pointed every old-Atlas state file at /workspace/extra/atlas-state/
// — which, post-be97e23, is the per-group GOVERNANCE dir (only audit/ and
// autonomy/ exist there) — and carried retired concepts (mode kill-switch,
// graduation milestones, evolution-log friction retros, the quiet-log check),
// so the 06:00 container briefing alarmed on "missing" files that live
// elsewhere or nowhere. Current mount design: gov dir RW at
// /workspace/extra/atlas-state; ~/.atlas read-only at /home/node/.atlas;
// entity profiles NOT mounted.
// NOTE: the live VPS scheduled_tasks row stores the prompt VERBATIM — this
// rewrite changes nothing on the VPS until the CEO-gated re-seed
// (npx tsx scripts/seed-orchestrator.ts --force).
const ORCHESTRATOR_PROMPT = `[ORCHESTRATOR — Daily Morning Digest]

You are Atlas running the daily 6AM orchestrator task. Your job: gather the system
state visible from this container and produce a concise morning briefing for the
CEO via Teams.

*Step 1: Preflight* (governance module handles this — if you're reading this, you passed)

*Step 2: Gather data*

Read these files and summarize what you find:

1. Quota: /workspace/extra/atlas-state/autonomy/quota-tracking.jsonl (today's entries; the calibration file is created lazily after a first rate-limit — its absence is normal)
2. Learning log (this group): /workspace/extra/atlas-state/autonomy/learning-log.jsonl (last 24h)
3. Approval queue: list files in /home/node/.atlas/approval-queue/pending/
4. Audit logs: /workspace/extra/atlas-state/audit/ (each subfolder, today's file)
5. Agent performance: /home/node/.atlas/agent-performance/ (read-only; written on the CEO's laptop and synced with lag — zero recent entries means "not visible from this host", never "failing")
6. System health: /home/node/.atlas/state/system-health.json (flag CRITICAL/WARNING only)
7. Entity profiles: NOT mounted in this container today. Say "entity status not visible from this container" — do not report entities as missing or unhealthy.
8. Shared workspaces: /workspace/extra/shared/{department}/ — count new directives/updates since yesterday and read every file in each department's escalations/ directory (if the mount is absent, skip this section silently).

If a file doesn't exist, note it briefly and move on. Don't error out.

*Step 3: Produce the digest*

Format for chat delivery (no markdown headings — use *bold* for sections):

*Morning Briefing — {today's date}*

*Needs Your Attention*
{Pending approval items with context. Anomalies. Failures on positive evidence. CRITICAL/WARNING system health. Empty = "Nothing urgent."}

*Overnight Activity*
{Counts derived ONLY from the audit logs (item 4) and learning log (item 2): runs, errors. If a count is not derivable from those files, write "no data" — never estimate.}

*Entity Status*
{Entity profiles are not mounted in this container — write "entity status not visible from this container." Never report entities as missing or unhealthy on that basis.}

*Quota*
{n} invocations | {weighted} weighted | {status}

*Shared Workspace Activity*
{Per department with activity since yesterday (item 8): new directives/updates counts. List pending escalations prominently, 1 line each. Omit the section if the shared mount is absent.}

*Priorities Today*
1. {Most important — specific, actionable}
2. {Second}
3. {Third}

Rules:
- Under 500 words
- Quantified — real numbers, not vague
- If data is missing, say "no data" not a paragraph explaining why
- Never alarm on data that is merely not visible from this container; only flag failures on positive evidence
- If everything is healthy, keep it short: "All systems nominal"
- Priorities should reference actual pending work, not generic advice
`;

// --- Main ---

const args = process.argv.slice(2);
const force = args.includes('--force');
const chatJidIdx = args.indexOf('--chat-jid');
let chatJid: string | undefined;
if (chatJidIdx >= 0) {
  const value = args[chatJidIdx + 1];
  // A present-but-empty/flag-shaped value is a hard error BEFORE resolution
  // (spec pre-review finding 3) — it must never silently fall through to the
  // default live-main path.
  if (!value || value.startsWith('--')) {
    console.error('--chat-jid requires a JID value.');
    process.exit(1);
  }
  chatJid = value;
}

// Find database
const dbPath = path.resolve('store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  console.error('Run this script from the NanoClaw project root.');
  process.exit(1);
}

const db = new Database(dbPath);

// Resolve (chat_jid, group_folder) via the shared resolver — registered + not
// knowably undeliverable, folder always from the row. Explicit --chat-jid must
// name a registered row whose shape a channel can own; default takes the live
// main. (A DB-side script cannot see live channels, so runtime ownership at
// send time remains the authoritative delivery check.)
const groupRows = db
  .prepare('SELECT jid, folder, is_main FROM registered_groups')
  .all() as Array<{ jid: string; folder: string; is_main: number | null }>;
const target = resolveSeedTarget(
  groupRows.map((r) => ({
    jid: r.jid,
    folder: r.folder,
    isMain: r.is_main === 1,
  })),
  chatJid,
);
if (!target.ok) {
  console.error(`Cannot seed orchestrator task: ${target.reason}`);
  process.exit(1);
}
console.log(`Seeding target: ${target.jid} (folder: ${target.folder})`);

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
  // True replace (wave-2 round-1 finding 1): --force rewrites EVERY
  // seeder-owned column — group_folder and chat_jid included — so a reseed
  // actually moves the task off a stale folder/JID. created_at and run
  // history (last_run, last_result, task_run_logs) are deliberately
  // preserved: delete-and-reinsert would orphan task_run_logs child rows and
  // erase operational history for the same logical task.
  db.prepare(`
    UPDATE scheduled_tasks
    SET group_folder = ?, chat_jid = ?, prompt = ?, schedule_type = ?,
        schedule_value = ?, context_mode = ?, next_run = ?, status = 'active'
    WHERE id = ?
  `).run(
    target.folder,
    target.jid,
    ORCHESTRATOR_PROMPT,
    SCHEDULE_TYPE,
    SCHEDULE_VALUE,
    CONTEXT_MODE,
    nextRun,
    TASK_ID,
  );
  console.log(`Replaced existing orchestrator task (full routing rewrite).`);
} else {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TASK_ID,
    target.folder,
    target.jid,
    ORCHESTRATOR_PROMPT,
    SCHEDULE_TYPE,
    SCHEDULE_VALUE,
    CONTEXT_MODE,
    nextRun,
    'active',
    new Date().toISOString(),
  );
  console.log(`Created orchestrator task.`);
}

console.log(`  ID:       ${TASK_ID}`);
console.log(`  Group:    ${target.folder}`);
console.log(`  Chat JID: ${target.jid}`);
console.log(`  Schedule: ${SCHEDULE_VALUE} (${TIMEZONE})`);
console.log(`  Next run: ${nextRun}`);
console.log('');
console.log('Done. The orchestrator will run at 6AM daily.');

db.close();
