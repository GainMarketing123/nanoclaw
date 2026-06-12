# Spec — seed-orchestrator reland on a shared JID-deliverability helper (al22 carry-over, 2026-06-12)

Reland of the wave-2 walk-back (`plans/al22-nanoclaw-walkback-2026-06-12.md`).
The four review rounds converged on one design demand: a single shared
"deliverable JID" contract instead of per-script guard lists. This spec adopts
that design up front. Spec-level codex pre-review happens BEFORE drafting code
(BEHAVIORS §1.5 rule 5); the review outcome is recorded at the bottom.

## Problem

`scripts/seed-orchestrator.ts` (as walked back to origin/main content) has four
known defects, all variants of "persists a routing target nothing can deliver
to": hard-coded `group_folder = 'atlas_main'`; default JID from
`WHERE is_main = 1 LIMIT 1` (not retirement-aware); `--force` that rewrites only
prompt/schedule/next_run/status; an explicit `--chat-jid` path that accepts any
string. The deliverability logic that would prevent this already exists — but
embedded in `src/ipc.ts` (callback resolution + `schedule_task` dispatch-alias
rewriting), not reusable.

## Contract: "deliverable JID"

A JID is DELIVERABLE iff an outbound channel can own it on the send path
(`findChannel → channel.ownsJid`). Two prefix classes are never deliverable:

1. **Logical aliases** — `dispatch:{folder}` (the bridge's Paperclip-workspace
   form). No outbound channel owns the prefix; the result-delivery message path
   does not resolve dispatch→real.
2. **Retired channels** — `RETIRED_CHANNEL_JID_PREFIXES` (`tg:` after the
   2026-06-03 Telegram retirement). Sends raise `RetiredChannelDropError` by
   design.

Deliverability is a JID-shape predicate. Registration is a separate predicate;
callers that need both (everyone below) combine them explicitly.

## API (src/router.ts — single source of truth)

`src/router.ts` already owns `isRetiredChannelJid` and `selectLiveMain`; the new
helpers live beside them. All pure functions — no DB, no IO, unit-testable.

```ts
// Logical JID prefixes that no outbound channel ever owns (module-internal —
// the public contract is isDeliverableJid; pre-review finding 4).
const NON_CHANNEL_JID_PREFIXES = ['dispatch:'] as const;

/** THE one answer to "can NanoClaw actually deliver to this JID?" */
export function isDeliverableJid(jid: string): boolean;
// !NON_CHANNEL prefix && !isRetiredChannelJid(jid)

/**
 * The deliverable JID registered for a folder, else undefined.
 * The map holds at most one current JID per folder (single-JID-per-folder
 * invariant enforced at the DB layer); the scan tolerates stale extra rows by
 * skipping non-deliverable ones and breaking remaining ties deterministically
 * (lexicographically smallest deliverable JID — pre-review finding 2; object
 * iteration order must never decide routing).
 */
export function resolveDeliverableJidForFolder(
  registeredGroups: Record<string, { folder: string }>,
  folder: string,
): string | undefined;

/** Resolution result for seeding a scheduled task. */
export type SeedTargetResult =
  | { ok: true; jid: string; folder: string }
  | { ok: false; reason: string };

/**
 * Resolve the (chat_jid, group_folder) pair a seeded task must target.
 * - explicitJid path: the JID must be a registered row AND deliverable;
 *   group_folder always comes from the row, never a constant.
 * - default path: selectLiveMain over the DELIVERABLE is_main candidates
 *   (retire-aware + deterministic, same selection every runtime mirror makes).
 * Fails closed with a human-readable reason; never falls back to a constant
 * folder or an unvalidated JID.
 */
export function resolveSeedTarget(
  rows: Array<{ jid: string; folder: string; isMain: boolean }>,
  explicitJid?: string,
): SeedTargetResult;
```

## Consumers (src/ipc.ts CONSUMES the helper — no mirrored copies)

1. `resolveCallbackJid` (host-task callback resolution): body becomes a
   delegation to `resolveDeliverableJidForFolder(...) ?? ''`. Exported name and
   call sites unchanged (the issuer round-trip test keeps exercising the same
   resolver production uses).
2. `processTaskIpc` `schedule_task`:
   - dispatch-alias rewrite: `resolveDeliverableJidForFolder(registeredGroups,
     dispatchFolder)` replaces the inline loop;
   - final deliverability guard: `!targetGroupEntry || !isDeliverableJid(targetJid)`
     replaces the inline prefix checks.
3. `scripts/seed-orchestrator.ts`: rebuilt on `resolveSeedTarget` (below).
4. `src/db.ts` `setRegisteredGroup` (pre-review finding 1, BLOCKING): the
   re-registration task-row rewrite (`UPDATE scheduled_tasks SET chat_jid = ?
   WHERE group_folder = ? AND chat_jid != ?`) is another writer of
   `scheduled_tasks.chat_jid`. Registering a folder under a NON-deliverable JID
   (e.g. a bridge `dispatch:{folder}` row) must NOT repoint existing task rows
   at the undeliverable target — guard the rewrite with `isDeliverableJid(jid)`
   so tasks keep their last deliverable JID instead.

## seed-orchestrator.ts semantics (reland)

- Read `jid, folder, is_main FROM registered_groups`; map to resolver rows.
- Default path: `resolveSeedTarget(rows)` → the live main's `(jid, folder)`.
  No `LIMIT 1`, no hard-coded folder — the scheduler resolves groups by folder
  (`src/task-scheduler.ts`), so the folder MUST be the selected row's.
- `--chat-jid <jid>`: `resolveSeedTarget(rows, jid)` — registered + deliverable
  or exit 1 with the reason (covers retired JIDs AND `dispatch:` aliases — the
  round-3 finding — and any future non-channel prefix in one place).
  A `--chat-jid` flag that is present but has a missing/empty/flag-shaped value
  is a hard error BEFORE resolution runs (pre-review finding 3) — it must never
  silently fall through to the default path.
- `--force` true replace: UPDATE every seeder-owned column —
  `group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode,
  next_run, status`. `created_at` and run history (`last_run`, `last_result`,
  `task_run_logs`) are deliberately preserved: delete-and-reinsert would orphan
  `task_run_logs` child rows (FK) and erase operational history for the same
  logical task.
- No registered rows / no live main / unresolvable `--chat-jid` → exit 1,
  explicit message. Never seed a row that cannot run or cannot deliver.

## Out of scope

- `host/host-executor.py` and `scripts/create-group.sh` mirrors: UNCHANGED.
  They only perform live-MAIN selection (already in lockstep with
  `selectLiveMain` since eadcb54); neither resolves folder→JID nor accepts
  operator-supplied JIDs, so the new helpers have no Python/shell mirror
  requirement. (A `dispatch:` alias cannot become `is_main=1`: bridge rows are
  never registered as main, and `ensureOwnerMainGroup`/`setRegisteredGroup`
  promote only owner-channel JIDs.)
- Host-task issuer fail-closed-on-empty-callback: separate follow-up commit in
  this landing (same helper, different contract — issuance policy, not JID
  resolution).
- The ORCHESTRATOR_PROMPT content rewrite: separate commit (briefing audit).
- VPS re-seed of the live DB row: CEO-gated, not this lane.

## Tests

- `src/routing.test.ts`: `isDeliverableJid` (real channel / `dispatch:` /
  `tg:`); `resolveDeliverableJidForFolder` (resolves, prefers deliverable over
  alias+retired for same folder, undefined when none, deterministic min-JID
  tie-break regardless of insertion order); `resolveSeedTarget`
  (explicit registered+deliverable OK with row folder; explicit unregistered /
  retired / dispatch each fail with reason; default selects live deliverable
  main with ITS folder; default fails when no live main; retired-main +
  live-main mix selects the live one).
- `src/db.test.ts`: re-registering a folder under a `dispatch:` JID does NOT
  rewrite existing task rows' `chat_jid`; a deliverable JID still does.
- `src/host-task-callback-roundtrip.test.ts`: unchanged in this commit — keeps
  proving resolveCallbackJid end-to-end through the shared helper.

## Review-history mapping (what this answers at root)

- Round 1 F1 (`--force` keeps stale routing) → true-replace UPDATE of all
  seeder-owned columns.
- Round 1 F2 (explicit path falls back to `atlas_main`) → folder always from
  the resolved row.
- Round 2 F2 (explicit path accepts retired) / Round 3 F1 (explicit path
  accepts `dispatch:`) → `isDeliverableJid` inside `resolveSeedTarget`, shared
  with `src/ipc.ts`, one contract.
- Round 4 F1–F3 carried-over dispositions → this reland.

## Codex spec pre-review (2026-06-12, codex exec read-only — ran BEFORE drafting)

Verdict: "close, and closes the four prior review findings at root on the
seeding path"; sound conditional on finding 1. All four findings adopted into
this spec:

1. BLOCKING — `setRegisteredGroup`'s task-row rewrite is another
   `scheduled_tasks.chat_jid` writer; guard it with `isDeliverableJid` →
   Consumers item 4.
2. SOFT — "first deliverable JID" is iteration-order-dependent → deterministic
   lexicographic tie-break in `resolveDeliverableJidForFolder`.
3. SOFT — present-but-empty `--chat-jid` must hard-error, never fall through to
   the default path → seeder semantics.
4. NIT — keep `NON_CHANNEL_JID_PREFIXES` module-internal; the public contract
   is `isDeliverableJid`.
