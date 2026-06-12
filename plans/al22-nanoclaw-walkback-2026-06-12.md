# al22 walk-back — scripts/seed-orchestrator.ts seeding-logic rework (2026-06-12)

## What happened

The wave-2 landing (66873e9f..) hit the review walk-back cap: four consecutive
codex FAIL_BLOCKING rounds, every round carrying a finding on the same area —
`scripts/seed-orchestrator.ts` seeding/routing-resolution semantics (`--force`
replace behavior, then the explicit `--chat-jid` path's deliverability:
folder resolution → retired-JID awareness → `dispatch:` alias awareness, with
the round-3 fix recommendation asking for a shared deliverability helper
mirroring `src/ipc.ts`). Each round's fix was accepted on the previously
flagged point and a new, broader requirement surfaced on the same path —
a specification spiral per BEHAVIORS §1.5 (cap 5 / walk back at 3 same-area
rounds).

Per protocol the contested item was WALKED BACK, not iterated further:
`scripts/seed-orchestrator.ts` is restored to its origin/main (66873e9f)
content plus ONLY the two uncontested prompt-wording hunks from 8df4e94
(Telegram → Teams; "Format for Telegram" → "Format for chat delivery").
The entire seeding-logic rework (retire-aware default seeding from bc57762,
live-main folder seeding from 6859c4f, DB-resolved `--chat-jid` + true
`--force` replace from 20924e0, retired-JID guard from eadcb54) is OUT of
this landing.

Everything else in the wave-2 landing stands — including the runtime
`is_main` core (persisted load-time demotion in `src/index.ts`,
retirement-aware + deterministic `selectLiveMain` in `src/router.ts` with
lockstep mirrors in `host/host-executor.py` and `scripts/create-group.sh`,
DB-resolved privileged IPC writers) — none of which carried a round-3
finding.

## OPERATIONAL WARNING (until reland)

Do NOT run `scripts/seed-orchestrator.ts` on the VPS. The walked-back script
has the known pre-wave-2 defects:

- default path picks `WHERE is_main = 1 LIMIT 1` (NOT retirement-aware on
  its own — it is only safe after the orchestrator has restarted once with
  the landed loadState normalization, which persistently demotes
  retired-channel mains);
- `group_folder` is hard-coded `'atlas_main'`, so the seeded task does not
  run when the live main lives in another folder (e.g. the VPS Teams main
  in `atlas_teams`) — the scheduler resolves groups by folder;
- `--force` only rewrites prompt/schedule/next_run/status (routing columns
  survive a reseed);
- the explicit `--chat-jid` path accepts any string.

The daily-digest task seeding stays a manual, eyes-open operation until the
relanded item ships.

## The four rounds, verbatim

### Round 0 — range review of 1879db6..460b9c7 (FAIL_BLOCKING, 3 findings: 2 blocking + 1 soft)

Ledger row predates this session's window; findings as recorded in
6859c4f's commit message (each fixed there):

1. BLOCKING — re-promoted main in a non-'atlas_main' folder black-holed
   host alerts. startIpcWatcher authorizes privileged IPC by matching the
   SOURCE folder to the registered main group's folder, but the host-side
   writers (host-executor.py send_alert + send_result, credential-proxy.ts
   sendAlert) emitted from a hard-coded data/ipc/atlas_main/messages — so
   with the live main in e.g. 'atlas_teams' (the VPS reality), alerts
   targeted the right JID and were rejected as "Unauthorized IPC message
   attempt blocked". [...] Same class fixed in seed-orchestrator.ts: the
   daily-digest task is now seeded under the live main's folder.
2. BLOCKING — credential-proxy sendAlert used CommonJS require() in a
   NodeNext ESM module: ReferenceError on every call, swallowed by the
   catch{}, so proxy auth alerts have silently never emitted.
3. SOFT — Python send_alert no longer mirrored selectLiveMainJid (first
   non-retired row vs folder-priority).

### Round 1 — review of 6859c4f3ea47e0b293241471b0332b69c816fd30 (FAIL_BLOCKING, 3 findings)

Ledger: cross-model-reviews.jsonl 2026-06-12T11:33:25Z, provider codex.

1. [state_mutation / blocking] scripts/seed-orchestrator.ts:158-165 —
   "`--force` reseeding updates the existing orchestrator row without
   rewriting `group_folder` or `chat_jid`." Why: "This patch's whole point
   is to move the daily task off stale `atlas_main`/retired Telegram
   targets, but the update path only changes prompt/schedule/next_run/
   status. If `atlas-orchestrator-daily` already exists from the old seed,
   `--force` leaves the old folder/JID in place. At runtime the scheduler
   still resolves by `task.group_folder` (`src/task-scheduler.ts:122-139`),
   so the task can keep failing with `Group not found`, and any stale
   `chat_jid` can still route delivery to a dead channel." Fix: "In the
   `existing` branch, also update `group_folder` and `chat_jid` (and
   preferably `context_mode`/`schedule_type` for a true replace), or
   delete-and-reinsert the row when `--force` is used."
2. [cross_file_call / blocking] scripts/seed-orchestrator.ts:127-140 —
   "The explicit `--chat-jid` path never resolves the matching group folder
   and silently falls back to `atlas_main`." Why: "When `--chat-jid` is
   supplied, `groupFolder` stays `FALLBACK_GROUP_FOLDER = 'atlas_main'`.
   Scheduled tasks are executed by matching `task.group_folder` to a
   registered group folder, not by `chat_jid`
   (`src/task-scheduler.ts:122-139`). Seeding a task for any registered
   main chat whose folder is not literally `atlas_main` produces a
   permanently broken task row even though the JID is valid." Fix: "When
   `--chat-jid` is provided, look up that JID in `registered_groups` and
   set `groupFolder` from the row; otherwise require a `--group-folder`
   argument and validate it against the DB."
3. [if_completeness / soft] scripts/create-group.sh:262-286 — "Step 4
   reimplements live-main selection with `live[0]` and can mutate the
   wrong main-group row." Why: "The rest of the patch standardizes main
   selection as 'first non-retired row whose `folder === 'main'`, else
   first live row' (`src/router.ts:110-120`, mirrored in
   `host/host-executor.py`). This shell script ignores that rule and uses
   SQLite's undefined row order. In a legacy multi-main DB, it can add the
   shared mount to a side-chat row that `loadState()` later demotes on
   restart, leaving the actual surviving main group without the shared
   mount." Fix: "Fetch `jid, folder, container_config` and apply the same
   selection rule as `selectLiveMain()` before updating `container_config`;
   do not rely on `LIMIT`/first-row ordering."

### Round 2 — review of 20924e0ca94ae5adc778ac7d6258fabc4230dbb6 (FAIL_BLOCKING, 2 findings)

Ledger: cross-model-reviews.jsonl 2026-06-12T12:16:17Z, provider codex.

1. [concurrency / blocking] src/router.ts:110-115 — "`selectLiveMain()`
   has no deterministic tie-breaker for the repo's real live-main folder
   names, so it falls back to unordered SQLite row order." Why: "The new
   routing stack assumes `folder === 'main'` is the canonical survivor,
   but fresh/main chats are still created and referenced elsewhere as
   `atlas_main` / `atlas_teams` (`src/index.ts` auto-registers
   `atlas_main`, and the repo has both `groups/main` and
   `groups/atlas_main`). When two live `is_main=1` rows exist and neither
   folder is literally `main`, every caller (`src/index.ts` load-time
   normalization, `src/credential-proxy.ts`, `host/host-executor.py`, and
   `scripts/create-group.sh`) picks `live[0]` from `SELECT ... WHERE
   is_main = 1` with no `ORDER BY`. Different processes can therefore
   disagree on which chat is \"the\" main group, causing CEO alerts /
   host-task results to be emitted from the wrong IPC source folder or the
   shared-workspace mount to be patched onto a row that is later demoted."
   Fix: "Make main selection deterministic across all runtimes. Either
   standardize on one canonical folder name everywhere (`main` or
   `atlas_main`) and migrate existing rows, or store an explicit
   priority/canonical flag and query with `ORDER BY` on that flag plus a
   stable secondary key. Update the TypeScript, Python, and shell mirrors
   together."
   → FIXED at root in eadcb547 (deterministic total order — folder rank,
   then smallest jid — in all three mirrors); NOT re-flagged in round 3.
2. [if_completeness / soft] scripts/seed-orchestrator.ts:137-154 — "The
   explicit `--chat-jid` path validates only \"registered\", not
   \"deliverable\", so it will happily seed the daily digest onto a retired
   channel JID." Why: "The default path is retirement-aware via
   `selectLiveMain()`, but the explicit path accepts any row returned by
   `SELECT folder FROM registered_groups WHERE jid = ?`. If an operator
   passes a still-registered retired JID such as `tg:...`, the task is
   created with that dead `chat_jid`; later the scheduler forwards output
   and auto-pause escalations to `task.chat_jid`
   (`src/task-scheduler.ts:223` and `:296`). That produces a permanently
   black-holed morning digest even though the task itself runs." Fix:
   "When `--chat-jid` is supplied, fetch both `jid` and `folder` and reject
   retired JIDs with `isRetiredChannelJid()` (or equivalent local check).
   If you want to support manual targeting, require an explicitly live
   registered group, not merely any registered row."
   → Fixed as specified in eadcb547; round 3 then broadened the same
   requirement (below). WALKED BACK with the script.

### Round 3 — review of eadcb54743a5ae1d1ea3c5b3dcc700fecbb1ecf6 (FAIL_BLOCKING, 1 finding)

Manual drive of the official run_code_review (force codex, no fallback,
pinned head_sha) after the auto runner crashed twice with PROVIDER_FAILURE
(provider "codex-sync-precommit-crash"; direct codex probe healthy).
Result: verdict FAIL_BLOCKING, files_reviewed 10, cross_file_traces 6,
duration 80.0s, provider codex, model codex-cli.

1. [if_completeness / blocking] scripts/seed-orchestrator.ts:139-167 —
   "The explicit `--chat-jid` path rejects retired JIDs but still accepts
   other non-deliverable registered JIDs such as `dispatch:{folder}`
   aliases." Why: "`registered_groups` can contain logical `dispatch:`
   JIDs, and `src/ipc.ts:359-416` already has to rewrite/reject them
   because no outbound channel owns that prefix. This script only calls
   `isRetiredChannelJid(chatJid)` and then persists the row's folder while
   leaving `scheduled_tasks.chat_jid` set to the alias. At runtime
   `src/task-scheduler.ts:199-223,288-300` delivers task output and
   auto-pause escalations to `task.chat_jid`; for a `dispatch:` alias that
   send path has no owning channel, so the task can run but its
   digest/results are dropped or error out on delivery." Fix: "In the
   explicit `--chat-jid` branch, reject any non-deliverable alias, not
   just retired prefixes. At minimum add
   `chatJid.startsWith('dispatch:')` to the guard; better, factor a shared
   deliverability check/rewrite helper that mirrors `src/ipc.ts` so this
   script only persists real channel JIDs."
   → WALK-BACK TRIGGER: third consecutive round on the explicit
   `--chat-jid` path, each round widening the deliverability spec.

## Recommended re-approach (reland as ONE specced item)

The spiral converged on the right design by round 3 — adopt it up front
instead of discovering it adversarially:

1. SPEC FIRST (per the spec-first standing policy, and send the spec to
   codex for spec-level pre-review BEFORE drafting): a single shared
   "deliverable JID" helper in `src/router.ts` (or a new
   `src/deliverability.ts`) that is THE one answer to "can NanoClaw
   actually deliver to this JID?" — covering retired prefixes
   (`isRetiredChannelJid`), logical `dispatch:{folder}` aliases (the
   rewrite/reject logic currently embedded in `src/ipc.ts:359-416`), and
   any future non-channel prefixes. `src/ipc.ts` must CONSUME the helper
   (single source of truth), not have it mirrored.
2. Rebuild the seed-orchestrator rework on top of it: retirement-aware
   default seeding via `selectLiveMain` (landed and reviewed — reuse
   as-is), DB-resolved `group_folder` for explicit `--chat-jid`, true
   `--force` replace (rewrite every routing column or
   delete-and-reinsert), and the deliverability gate via the shared
   helper.
3. Add script-level tests (the wave-2 rounds shipped logic in an untested
   operator script; a small extracted `resolveSeedTarget()` function in
   src/ would make the resolution unit-testable and reviewable in one
   round).
4. Re-run the official review; this should converge in one round because
   the deliverability contract is then a reviewed, shared surface instead
   of an ad-hoc per-script guard list.

Tracking: roadmap item to be added under the al22 arc carry-overs
(operational tracking lives in ~/.atlas/plans/ecosystem-roadmap.md, not
here — this file is the in-repo record of the walk-back itself).
