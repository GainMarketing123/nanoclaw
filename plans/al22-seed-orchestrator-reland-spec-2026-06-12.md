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

## Contract: "knowably-undeliverable JID" (amended in commit-review round 1)

The shared predicate is CONSERVATIVE and one-sided: it answers "does this
JID's SHAPE alone guarantee that no outbound channel can ever own it on the
send path (`findChannel → channel.ownsJid`)?". Two prefix classes qualify:

1. **Logical aliases** — `dispatch:{folder}` (the bridge's Paperclip-workspace
   form). No outbound channel owns the prefix; the result-delivery message path
   does not resolve dispatch→real.
2. **Retired channels** — `RETIRED_CHANNEL_JID_PREFIXES` (`tg:` after the
   2026-06-03 Telegram retirement). Sends raise `RetiredChannelDropError` by
   design.

A `false` result means "not KNOWABLY undeliverable", NOT "delivery
guaranteed" (commit-review round 1 finding 1): a registered, non-retired,
non-alias JID can still be unowned at send time — e.g. a WhatsApp `@g.us` row
while the WhatsApp channel is not running, and a DB-side seeder cannot see
live channels at all. Live channel ownership at send time remains the
authoritative delivery check. The predicate exists so writers of persistent
routing targets never store a target that is GUARANTEED dead. Registration is
a separate predicate; callers that need both combine them explicitly.

## API (src/router.ts — single source of truth)

`src/router.ts` already owns `isRetiredChannelJid` and `selectLiveMain`; the new
helpers live beside them. All pure functions — no DB, no IO, unit-testable.

```ts
// Logical JID prefixes that no outbound channel ever owns (module-internal —
// the public contract is isKnownUndeliverableJid; pre-review finding 4).
// Lockstep mirrors: host/host-executor.py NON_CHANNEL_JID_PREFIXES,
// scripts/create-group.sh step 4.
const NON_CHANNEL_JID_PREFIXES = ['dispatch:'] as const;

/** True iff the JID shape GUARANTEES no channel can ever own it. */
export function isKnownUndeliverableJid(jid: string): boolean;
// NON_CHANNEL prefix || isRetiredChannelJid(jid)

/**
 * The registered channel JID for a folder, else undefined. Skips
 * knowably-undeliverable rows; NOT a delivery guarantee.
 * The map holds at most one current JID per folder (single-JID-per-folder
 * invariant enforced at the DB layer); the scan tolerates stale extra rows by
 * skipping flagged ones and breaking remaining ties deterministically
 * (lexicographically smallest JID — pre-review finding 2; object
 * iteration order must never decide routing).
 */
export function resolveChannelJidForFolder(
  registeredGroups: Record<string, { folder: string }>,
  folder: string,
): string | undefined;

/** Resolution result for seeding a scheduled task. */
export type SeedTargetResult =
  | { ok: true; jid: string; folder: string }
  | { ok: false; reason: string };

/**
 * Resolve the (chat_jid, group_folder) pair a seeded task must target.
 * - explicitJid path: the JID must be a registered row AND not knowably
 *   undeliverable; group_folder always comes from the row, never a constant.
 * - default path: selectLiveMain over the is_main candidates (which itself
 *   excludes knowably-undeliverable JIDs — retire/alias-aware +
 *   deterministic, same selection every runtime mirror makes).
 * Fails closed with a human-readable reason; never falls back to a constant
 * folder or an unvalidated JID. Validation is "registered + not knowably
 * undeliverable": a DB-side script cannot see live channels, so runtime
 * ownership at send time stays authoritative (round-1 finding 1).
 */
export function resolveSeedTarget(
  rows: Array<{ jid: string; folder: string; isMain: boolean }>,
  explicitJid?: string,
): SeedTargetResult;
```

## Consumers (src/ipc.ts CONSUMES the helper — no mirrored copies)

1. `resolveCallbackJid` (host-task callback resolution): body becomes a
   delegation to `resolveChannelJidForFolder(...) ?? ''`. Exported name and
   call sites unchanged (the issuer round-trip test keeps exercising the same
   resolver production uses).
2. `processTaskIpc` `schedule_task`:
   - dispatch-alias rewrite: `resolveChannelJidForFolder(registeredGroups,
     dispatchFolder)` replaces the inline loop;
   - final guard: `!targetGroupEntry || isKnownUndeliverableJid(targetJid)`
     replaces the inline prefix checks.
3. `scripts/seed-orchestrator.ts`: rebuilt on `resolveSeedTarget` (below).
4. `src/db.ts` `setRegisteredGroup` (pre-review finding 1, BLOCKING): the
   re-registration task-row rewrite (`UPDATE scheduled_tasks SET chat_jid = ?
   WHERE group_folder = ? AND chat_jid != ?`) is another writer of
   `scheduled_tasks.chat_jid`. Registering a folder under a knowably-
   undeliverable JID (e.g. a bridge `dispatch:{folder}` row) must NOT repoint
   existing task rows at it — the rewrite is gated on
   `!isKnownUndeliverableJid(jid)` so tasks keep their last channel JID.
5. `src/db.ts` `setRegisteredGroup` main-promotion invariant (commit-review
   round 1 finding 2): `group.isMain && isKnownUndeliverableJid(jid)` THROWS
   (same contract as the invalid-folder throw). No production caller passes
   such a JID with isMain — this is an invariant backstop; tests simulating
   legacy pre-invariant rows use the `_setGroupIsMainUnchecked` test helper.
6. `selectLiveMain` (src/router.ts) + its mirrors `host/host-executor.py
   select_live_main_row` + `scripts/create-group.sh` step 4 (commit-review
   round 1 finding 2): the live filter extends from retired-only to
   knowably-undeliverable (retired + alias), in lockstep, so a legacy or
   hand-edited `dispatch:` main row can never win selection in ANY runtime.

## seed-orchestrator.ts semantics (reland)

- Read `jid, folder, is_main FROM registered_groups`; map to resolver rows.
- Default path: `resolveSeedTarget(rows)` → the live main's `(jid, folder)`.
  No `LIMIT 1`, no hard-coded folder — the scheduler resolves groups by folder
  (`src/task-scheduler.ts`), so the folder MUST be the selected row's.
- `--chat-jid <jid>`: `resolveSeedTarget(rows, jid)` — registered + not
  knowably undeliverable, or exit 1 with the reason (covers retired JIDs AND
  `dispatch:` aliases — the round-3 finding — and any future non-channel
  prefix in one place).
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

- ~~`host/host-executor.py` and `scripts/create-group.sh` mirrors: UNCHANGED~~
  — REVERSED by commit-review round 1 finding 2: the claimed "a `dispatch:`
  alias cannot become `is_main=1`" invariant did not hold at the write layer,
  so the mirrors ARE updated in lockstep (Consumers item 6) and the write
  layer now enforces the invariant (Consumers item 5).
- Host-task issuer fail-closed-on-empty-callback: separate follow-up commit in
  this landing (same helper, different contract — issuance policy, not JID
  resolution).
- The ORCHESTRATOR_PROMPT content rewrite: separate commit (briefing audit).
- VPS re-seed of the live DB row: CEO-gated, not this lane.

## Tests

- `src/routing.test.ts`: `isKnownUndeliverableJid` (real channel / `dispatch:`
  / `tg:` / conservative on unmapped shapes); `resolveChannelJidForFolder`
  (resolves, prefers the channel JID over alias+retired for same folder,
  undefined when none, deterministic min-JID tie-break regardless of insertion
  order); `resolveSeedTarget` (explicit registered channel JID OK with row
  folder; explicit unregistered / retired / dispatch each fail with reason;
  default selects live main with ITS folder; default fails when no live main;
  undeliverable-main + live-main mix selects the live one); `selectLiveMain`
  never selects a `dispatch:` row.
- `src/db.test.ts`: re-registering a folder under a `dispatch:` JID does NOT
  rewrite existing task rows' `chat_jid`; a channel JID still does; main
  promotion of `tg:`/`dispatch:` JIDs throws and writes nothing; undeliverable
  JIDs still register as non-main rows.
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
   is the shared predicate.

## Commit-review round 1 (codex FAIL_BLOCKING on the spec commit 8299301)

Both findings adopted at root before any implementation landed:

1. BLOCKING — "deliverable" overclaimed: the prefix blacklist cannot prove a
   channel owns a JID (registered, non-retired, non-alias JIDs can still be
   unowned at send time; a DB-side script sees no channels at all). ADOPTED:
   contract recast as the conservative `isKnownUndeliverableJid` (true only
   when the shape GUARANTEES non-delivery); call sites pair it with
   registration checks; runtime ownership stays authoritative. Helper renamed
   `resolveChannelJidForFolder`.
2. BLOCKING — the "dispatch: can never be is_main" invariant was false at the
   write layer, so unchanged Python/shell mirrors could disagree with the TS
   reland about the live main. ADOPTED — both reviewer options: write-layer
   rejection in `setRegisteredGroup` (Consumers item 5) AND lockstep
   alias-exclusion in `selectLiveMain` + both mirrors (Consumers item 6).
