# Lane Report: al2-2026-06-03-comms

## Commit Table

| # | Hash | Description |
|---|------|-------------|
| 1 | `f14f6c7` | feat(comms): remove Telegram channel + fix pre-existing test isolation bugs |
| 2 | `5099e11` | fix(index): resolve d72146a F1+F2 — sender-allowlist before loom + timeout guard |
| 3 | `3ae0a32` | fix(credential-proxy): EACCES fallback when CLAUDE_CONFIG_DIR points at another user's home |

---

## CONFIRMATION: d72146a F1+F2 Resolved

Both findings from the d72146a cross-review are resolved in commit `5099e11`:

**F1 (BLOCKING — auth-bypass):** `src/index.ts` `onMessage` callback — loom
command dispatch previously ran before the sender-allowlist enforcement, so a
DENIED sender could trigger course-brain Q&A without authorization. Fixed by
moving the `3d-2 sender-allowlist` block AHEAD of the `parseLoomQuestion`
dispatch. Denied senders are now rejected before any loom handling.

**F2 (SOFT — NaN timeout):** `LOOM_BRAIN_TIMEOUT_MS` env parsing used
`parseInt(process.env.LOOM_BRAIN_TIMEOUT_MS || '45000', 10)`. The `|| '45000'`
fallback only applies when the env var is unset/empty; when it's set to a
non-numeric value `parseInt` returns `NaN`, which flows into `SecondBrainClient`.
Fixed with `Number(...)` + `Number.isFinite()` guard:
```typescript
const _loomTimeoutRaw = Number(process.env.LOOM_BRAIN_TIMEOUT_MS);
{ timeoutMs: Number.isFinite(_loomTimeoutRaw) ? _loomTimeoutRaw : 45000 }
```

---

## EACCES Root Cause + Fix

### Root Cause

`credential-proxy.ts` builds `CREDENTIALS_PATH = path.join(HOST_CLAUDE_DIR, '.credentials.json')`.

`HOST_CLAUDE_DIR` comes from `CLAUDE_CONFIG_DIR` env var (or defaults to
`$HOME/.claude`). The shared environment file `/etc/atlas/atlas.env` has
`CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude` — set there for the Phase 3.2
host-executor migration (moving `atlas-host-executor.service` from `User=atlas`
to `User=nanoclaw-he`).

The nanoclaw orchestrator service (`systemctl --user start nanoclaw`) sources the
same shared env file and inherits `CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude`.
The orchestrator runs as a **different user** (not `nanoclaw-he`), so
`/home/nanoclaw-he/.claude/.credentials.json` (owned by `nanoclaw-he`, mode
`0600`) throws `EACCES` when the orchestrator reads it.

The pre-fix catch block only logged a warning and fell back to the `.env`
`CLAUDE_CODE_OAUTH_TOKEN` — which is empty post-Phase 3.1 (key moved to systemd
`LoadCredential=`). The proxy started with no credentials → containers get 401 →
Wed 6AM Teams digest fails.

### Code Fix (commit `3ae0a32`)

Added `readRawOauthRecord()` helper that tries `CREDENTIALS_PATH` first, then
`CREDENTIALS_PATH_FALLBACK` (`os.homedir()/.claude/.credentials.json`) when the
primary path throws `EACCES`. Both `loadCredentials()` and the proactive 5-minute
refresh `setInterval` now delegate to this helper.

When `EACCES` is hit, a `WARN` log entry names the configured path and the
fallback being used, so operators can identify the misconfiguration.

### Permanent VPS Fix (for orchestrator deploy)

The code fix is a defensive fallback. The proper remediation is to **remove
`CLAUDE_CONFIG_DIR` from `/etc/atlas/atlas.env`** and instead set it only in the
`atlas-host-executor.service` unit (inline `Environment=` or a host-executor-only
env file). The `atlas-host-executor.service` in-tree file already has this
documented in the `Codex 7c7401b F2 BLOCKING revert` comment block — the same
class of mistake.

---

## Build / Test Results

- `npm run build` (tsc): **PASS** — zero errors across all three commits
- `npm test` (vitest): **286/286 PASS** on every commit

Two pre-existing test bugs in `src/credential-proxy.test.ts` were fixed in
commit `f14f6c7` (these were unrelated to the Telegram removal but surfaced
during the test run):
1. **TDZ `ReferenceError`**: `vi.mock` factory referenced `mockEnv` before its
   `const` declaration was initialized (Vitest hoisting). Fixed with `vi.hoisted()`.
2. **OAuth isolation**: `loadCredentials()` read the real `~/.claude/.credentials.json`
   on disk and overrode the mock env token. Fixed with `vi.mock('fs')` that returns
   `false` for `.credentials.json` existence checks during tests.

---

## Cross-Review Status

`nanoclaw-comms/.claude/settings.json` is `{}` (empty — no hooks configured for
this repo). No cross-review entries appeared in
`~/.atlas/hook-health/cross-model-reviews.jsonl` for any of the three commits.
**PROVIDER_FAILURE** — noted per discipline; orchestrator should be aware that
cross-review was not performed for this lane.

---

## Notes for Orchestrator VPS Deploy

1. **CLAUDE_CONFIG_DIR misconfiguration** (Part C root fix): After deploying,
   edit `/etc/atlas/atlas.env` — remove the `CLAUDE_CONFIG_DIR=` line from the
   shared file and add it only to the `atlas-host-executor.service` unit (or a
   host-executor-only env override). Without this VPS-side step, the EACCES
   fallback in code will activate on every restart — it works, but the proper
   owner alignment is cleaner and removes the warning noise.

2. **grammy removed**: `npm install` was run to remove the package. The
   `node_modules/grammy` directory will be absent after deploying
   (the package-lock.json update is included in the commit). No container
   rebuild is needed — grammy was only used by the orchestrator, not the
   agent container.

3. **TELEGRAM_CEO_USER_ID**: This env var is no longer read by the codebase.
   It can be removed from `/etc/atlas/atlas.env` and any `.env` files during
   the next cleanup sweep. Leaving it set is harmless.

4. **CEO command gating**: The `TELEGRAM_CEO_USER_ID` sender-match gate in
   `commands.ts` has been removed. CEO-only commands (`/approve`, `/reject`,
   `/pause`, `/resume`, `/reset-mode`, `/mission`) are now guarded exclusively
   by the Teams channel's owner gate (`isOwner()` in `teams.ts`), which was
   already the production enforcement path.

5. **Wed 6AM digest verification**: After deploying, the first Teams digest run
   (Wed 6AM ET) will verify the EACCES fix end-to-end. If the WARN log
   `EACCES reading credentials.json — trying process-home fallback` appears, the
   VPS-side `atlas.env` fix (item 1 above) is still pending. If no WARN and the
   digest runs clean, both fixes are working.
