# Overnight Build Lane N1 — Report (arc: night-2026-06-11)

Branch: `night1-hosttask-roundtrip-telegram` (off `origin/main` @ `206430f`).
Two independent topics, two commits. Build + unit-test + review-converged.
NOT merged to main, NOT deployed, nothing restarted — morning integration +
re-verify per the brief.

## Per-commit table

| Commit | Topic | Files | Verdict |
|---|---|---|---|
| `5bb3f6f301793db36202d37a896fb0fe1d30b4a7` | A — host-task round-trip | `src/ipc.ts`, `src/host-task-callback-roundtrip.test.ts` (new), `host/host-executor.py`, `infra/systemd-dropins/atlas-host-executor.service.d/hardening.conf` (new) | Auto-runner cross-review **PASS** |
| `5a0a6e7b8bb1736acb32074fa9b1b67971718a10` | B — remove dead Telegram wiring | `src/index.ts`, `src/router.ts`, `src/channels/retired-channel-no-fault.test.ts` (new), `infra/host-task-policy.json` | Manual review (auto-runner starved): 1 BLOCKING r1 fixed at root, r2 clean |
| `2e40d79a80899a2e244387cc8d3ccb542273360d` | (docs) lane report | `plans/night1-lane-report.md` | Docs-only |
| `3757dbdff3659a362f1cdb3757f4caaf47e63154` | B follow-up (review F2) | `src/index.ts`, `src/router.ts`, `src/ipc.ts`, `src/channels/retired-channel-no-fault.test.ts` | Range review fix: retired drop is a TYPED non-delivery, not a false "sent" |
| `3108b535a6e33a8631dd20fb99135931c4bf1bb2` | A+B follow-up (review F1+F2) | `src/ipc.ts`, `src/host-task-callback-roundtrip.test.ts` | Range review fix: no doc-payload leak; callback JID must be deliverable |

**Final convergence:** cumulative review over `origin/main..HEAD` (all 5 commits)
— fast_screen PASS + deep review **PASS, 0 findings**; genuine PASS cert
`83699b1b` issued, push-allowed. The review loop ran 3 rounds, each surfacing
DISTINCT new concerns (r1 false-"sent" log → r2 doc-payload leak + non-routable
`dispatch:` callback → r3 PASS) — convergence, not same-concern spiral.

Test/typecheck state at branch tip: `tsc --noEmit` clean; `vitest` **343/343**
(330 baseline + Topic A round-trip/resolver + Topic B retired-channel/typed-error
guards); `python3 -B host/test_host_task_{auth,runtime}.py` OK; prettier clean.

---

## Topic A — host-task round-trip fixes

### Defect 1 — blank `callback_group` (results never routed back)

**Status: root-fixed + coverage added.** The root fix already landed on
`origin/main` in `9bfe105` (the live trace ran against the *deployed* build,
which predated it). `src/ipc.ts` resolves the requester's registered chat JID
from its unforgeable folder and the issuer stamps it into the **signed** task
before `sign()` (`callback_group` is part of the canonical signature input).
The remaining gap was **test coverage**: the folder→JID resolution lived inline
and no test exercised it (issuer tests passed a literal `callbackJid`).

- Extracted the loop into an exported pure `resolveCallbackJid(registeredGroups,
  sourceGroup)` so prod + test share one implementation, and wired the
  `host_task` IPC case to call it.
- Added `src/host-task-callback-roundtrip.test.ts`: requester folder →
  `resolveCallbackJid` → `evaluateHostTaskRequest` → `sign` → `verify`, asserting
  the signed `callback_group` is the resolved JID, that a wrong key fails
  (it's a signed field), and that an unresolvable folder yields an empty
  (best-effort, delivery-skipped) `callback_group`.

**Built + unit-tested.** Live E2E is blocked on the host's expired Claude
credential (morning — see Blockers).

### Defect 2 — "Project directory not found" for `/home/atlas/projects/gpg`

**Status: ROOT CAUSE = systemd sandbox mount, NOT app code, NOT a missing dir.**
Confirmed read-only on the VPS: `/home/atlas/projects/gpg` **exists**
(`drwxrwxr-x atlas:atlas`). The executor's systemd drop-in
`/etc/systemd/system/atlas-host-executor.service.d/hardening.conf` sets
`ProtectHome=tmpfs` and `BindPaths=/home/atlas/nanoclaw /home/atlas/.atlas` —
`/home/atlas/projects` is **not bind-mounted** into the executor's namespace,
so `os.path.isdir()` reads the real, host-present dir as absent. (Request 2's
`/home/atlas/nanoclaw` passed because nanoclaw IS bound; that's why only the
gpg request hit the wall.)

- **Code (in scope):** improved the executor's error message
  (`host/host-executor.py`) so a path that already passed the issuer's
  realpath+policy allowlist but reads `isdir`-False is diagnosed as a likely
  sandbox/`BindPaths` visibility gap *or* a post-issuance removal — naming the
  concrete remediation without over-attributing (per design review: a verified
  task's path can still legitimately vanish after issue).
- **Infra (in scope, git-managed root fix):** mirrored the live VPS
  `hardening.conf` into `infra/systemd-dropins/atlas-host-executor.service.d/`
  and added the THREE policy-allowed project roots to `BindPaths`
  (`/home/atlas/projects/{gpg,crownscape,wisestream}`), NOT the parent
  `/home/atlas/projects` — binding the parent would make every group's siblings
  visible in the executor namespace (cross-review: defense-in-depth, mount only
  what a policy needs; keep this list in sync if a new project root is added).
  **Live apply is a morning step** (this repo only tracks the source-of-truth;
  the live file is root-owned VPS state).

**No genuinely-missing dir** — so nothing to create. Project-dir *resolution*
(realpath + allowlist + escape-path) is unit-tested on the issuer side
(`src/host-task-issuer.test.ts`: `project_dir_not_allowed`, escape-path). The
executor's `isdir` branch is behavior-unchanged (message only) and lives in the
monolithic `process_task`, not independently unit-testable; live E2E is
credential-blocked regardless.

---

## Topic B — remove dead Telegram wiring (Telegram is intentionally retired)

**Status: false-alarm source removed at root + discrimination added.** Telegram
was retired on purpose (Teams is primary). The running build kept raising a
false `No channel for JID: tg:…` fault because the IPC-watcher send callbacks
*threw* on any unowned JID, and retired `tg:` group rows still live in the DB.

- `src/index.ts`: the three IPC-watcher send callbacks now route a no-channel
  result through a shared `handleNoChannel` helper that **warn-drops only for
  retired-channel JIDs** and **still throws for any other unowned JID**.
- `src/router.ts`: added `RETIRED_CHANNEL_JID_PREFIXES` (`['tg:']`) +
  `isRetiredChannelJid()` — one exported, tested predicate.
- `infra/host-task-policy.json`: removed the dead `telegram_atlas-marketing`
  policy row (Telegram-only group; can no longer issue/receive host-tasks).
- `src/channels/retired-channel-no-fault.test.ts`: a `tg:` JID resolves to no
  owning channel (expected) while Teams still resolves, and `isRetiredChannelJid`
  discriminates retired (`tg:`) from live/unknown JIDs.

**Why the discrimination is load-bearing (cross-review F1):** the IPC watcher
(`src/ipc.ts`) only preserves the IPC file to `data/ipc/errors` when a send
*throws*. The first cut warn-dropped *every* unowned JID — which would silently
lose a message destined for a live-but-temporarily-unmapped channel and unlink
its document payload while logging a false "sent" success. Fixed at root: only
retired JIDs drop quietly; a genuine misroute still surfaces and is preserved.

### Telegram remnants NOT removed (deliberate)

- **Live `registered_groups` DB rows** `atlas_main` (`tg:7322433447`) and
  `telegram_atlas-marketing` (`tg:-5063551496`): these are LIVE DB data, not
  code. Per the brief I did NOT delete them. Code no longer treats their
  absence-of-channel as a fault. **CEO decision for the morning:** purge these
  rows from the live DB, or leave them (now harmless).
- **`src/db.ts` historical `tg:` relabel migration** (sets `channel='telegram'`
  on legacy rows): kept — harmless data-labeling; removing it would leave those
  rows `channel=NULL`, which is worse for queryability. Comment already
  documents retirement.
- **`container/agent-runner/` cosmetic "Telegram" strings** (governance comments
  + MCP tool-description examples like "messages appear from a dedicated bot in
  Telegram"): stale doc text in a separate container deploy artifact; misleads
  the container agent but does NOT generate the health-check fault. Left as-is
  (out of this lane's fault-removal scope; flag for a future doc sweep).
- **Dead `routeOutbound` / `routeOutboundDocument` in `src/router.ts`**: throw
  the same `No channel for JID` but have **no live callers** — left throwing
  (loud error is the safe default for a future caller).
- **Stale local `dist/channels/telegram.*`** build artifacts: `dist/` is
  gitignored (not committed). Removed locally for build hygiene. On the VPS they
  are removed by a clean rebuild — see morning steps.

---

## Items surfacing during work (in scope, addressed — all fixed at root)

- **Topic B manual round 1:** blanket warn-and-drop for ALL unowned JIDs would
  silently lose live-but-unmapped sends → added retired-prefix discrimination.
- **Range review F2 (commit 3757dbd):** even after discrimination, a retired
  drop RESOLVED, so the IPC watcher logged a false "IPC message/document sent"
  and unlinked the payload — corrupting the delivery/audit log. Fixed: typed
  `RetiredChannelDropError`; watcher logs "dropped" (not "sent"/"error").
- **Range review F1+F2 (commit 3108b53):** (F1) retired-channel DOCUMENT drop
  leaked the uploaded payload (throw short-circuited the post-send unlink) →
  unlink the payload on drop where it is in scope. (F2) `resolveCallbackJid`
  could return a non-deliverable `dispatch:` bridge alias as the callback
  target — same non-routable-callback class as the original blank-callback bug
  → skip dispatch aliases, prefer a deliverable real JID, dispatch-only ⇒ ''.
- **Auto cross-review runner was STARVED** the entire session (single global
  runner pinned on another session's commit `1ed43057`; my PostToolUse spawns
  lost the lock race and left no pending request). Drove every official review
  manually via the real pipeline (`run_fast_screen` + `run_code_review` codex,
  no fallback, single-repo) and minted genuine range certs, per the brief's
  stall contract. Blocking verdicts were ack'd as "fixing at root" (never
  waved) and superseded by the clean PASS at HEAD.

## Boarded follow-up (out of this lane's two-topic scope)

- **`resolveCallbackJid` stale-JID-per-folder (cross-review soft, re-flagged):**
  the in-memory `registeredGroups` map can in principle retain a stale JID key
  for a re-registered folder; the resolver returns the first deliverable match.
  Worst case is a syntactically-valid-but-stale JID (the router drops an unowned
  one — no cross-group misroute), and the map is rebuilt from the DB at startup.
  A full fix is a DB migration enforcing one-current-JID-per-folder — a
  schema/migration-layer change outside the host-task-round-trip + Telegram
  scope of this lane. Documented in code as a best-effort contract; board for a
  dedicated DB-hygiene change. NOT chased here (avoiding scope creep / spiral).

## Blockers / decisions for morning

1. **Host Claude credential (Topic A live E2E):** the host's `claude -p` OAuth
   token is expired (live trace req2). Refresh it on the VPS under the executor
   user before the round-trip can go green end-to-end. Build + unit-test + review
   were this lane's scope.
2. **Apply the BindPaths drop-in (Topic A defect 2):** copy
   `infra/systemd-dropins/atlas-host-executor.service.d/hardening.conf` to
   `/etc/systemd/system/atlas-host-executor.service.d/hardening.conf` (root-owned),
   `systemctl daemon-reload`, restart `atlas-host-executor` (restart-queue or
   docker-root nsenter — atlas has no `systemctl restart` grant). NO dir to
   create; `/home/atlas/projects/gpg` already exists.
3. **Telegram DB rows (Topic B):** CEO decision — purge the `tg:` rows from the
   live `registered_groups`, or leave them (code no longer faults on them).
4. **Live host-task-policy.json:** `infra/host-task-policy.json` is the repo
   source; the live `/etc/atlas/host-task-policy.json` is a separate CEO-installed
   file. After merge, re-install it (sans `telegram_atlas-marketing`) if the CEO
   wants the live policy to match.

## Morning integration / deploy steps (exact)

1. Re-verify both commits' reviews from the ledger / re-run as needed; merge
   `night1-hosttask-roundtrip-telegram` into `main` (integration lane issues
   certs + pushes; this lane pushed the FEATURE BRANCH only).
2. After merge + push, `git-sync.sh` deploys nanoclaw to the VPS. Then run a
   clean container/dist rebuild so the stale `dist/channels/telegram.js` is gone
   on the VPS (per CLAUDE.md container build-cache note: `docker builder prune -f`
   then `bash container/build.sh`; and `npm run build` + `regen-config-hashes.sh`).
3. Apply the `hardening.conf` BindPaths drop-in + daemon-reload + restart (step 2
   above).
4. Refresh the host Claude credential (blocker 1).
5. Re-run the §B3 step-E host-task round-trip verification (a Teams host_task to
   `/home/atlas/projects/gpg`): expect a non-empty `callback_group`, a visible
   project dir, a successful `claude -p`, and the result delivered back to the
   Teams chat.
