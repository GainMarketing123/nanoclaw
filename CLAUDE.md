# NanoClaw

## Identity

Personal Claude assistant (v2.0.0). The Atlas runtime that sits on the VPS — a single Node.js orchestrator that routes messages from chat channels (Telegram, WhatsApp, Slack, Discord, Gmail) into containerized Claude Agent SDK sessions. Each "group" is an isolated filesystem + memory boundary. Three-layer execution: orchestrator → host-executor (`claude -p` on the VPS host) → containers (Tier 2+ uses `--worktree` isolation for parallel work).

The README + `docs/REQUIREMENTS.md` are the deeper architecture references.

## Current State

- **Version:** v2.0.0 (Mission Control redesign — bridge-first, SQLite-backed mission lifecycle).
- **Mission lifecycle:** `create → pending_approval → approved → executing → synthesis → complete`. Missions flow through the Atlas Bridge (HTTP) for Paperclip integration, constraint enforcement, security evaluation. CEO approves/rejects via Telegram inline keyboards.
- **Auth gating:** CEO-only commands gated by `TELEGRAM_CEO_USER_ID`.
- **Atlas paths quartet (post-2026-05-08):** nanoclaw carries a byte-identical copy of `lib/atlas_paths.py` matching atlas-engineering / atlas-operations / atlas-shared. `host/host-executor.py` uses the shared `env_or_home(strict=...)` helper.
- **Phase 3.0 (1.A.6) landed 2026-05-04:** host-executor paths block fail-closes when `ATLAS_HOST_MODE=production`. Module-level `_ATLAS_LIB_PATH` prefers root-owned `/usr/local/lib/atlas` when complete, else falls back to `ATLAS_DIR/lib`. SSRF `ImportError` handler fail-closes (rejects task) instead of logging-and-continuing. `git-sync.sh` mirrors `~/.atlas/lib` into `/usr/local/lib/atlas` after every atlas-core pull (sudoers grant at `infra/sudoers.d/atlas-rsync`).
- **Phase 3.1 (1.A.6) landed 2026-05-05:** `ANTHROPIC_API_KEY` migrated from `EnvironmentFile=` to systemd `LoadCredential=` (root-owned source `/etc/atlas/anthropic-api-key.secret`, mode 0400). `_load_anthropic_api_key()` order: `$CREDENTIALS_DIRECTORY/anthropic-api-key` → env var → `.env`. Verified end-to-end via synthetic `/quality-check` probe (Haiku grading, 6.2s).
- **Phase 3.2 (1.A.6) in flight 2026-05-06:** atlas-host-executor service identity migrating from `User=gateway` to dedicated `User=nanoclaw-he`. SSH + Claude OAuth credentials moving to `/home/nanoclaw-he/.{ssh,claude,gitconfig}`. Two ed25519 deploy keys (one per repo per GitHub policy) replace the gateway shared key. Plan: `~/.atlas/plans/1-a-6-phase-3-2-user-split.md`.
- **2026-05-12 sweep:** `git-sync.sh` env parser hardened to strip whitespace around `=` (matches systemd `EnvironmentFile=` behavior). `groups/atlas_crownscape/CLAUDE.md` carries FROZEN-until-acquisition-close status (CEO D1).
- **2026-05-17 Wave 1 Lane C propagation:** `lib/atlas_paths.py` quartet (atlas-engineering, atlas-shared, atlas-operations, nanoclaw) received the symbol-manifest-aware refactor — `resolve_lib_path_for()` now accepts `required_symbols` dict and validates via AST that candidate `lib/` paths export the required named symbols (not just file presence). Prevents mixed-version override deployments from silently bootstrapping a partial-tree where downstream imports crash on `ImportError` after bootstrap "succeeded". All 21 Atlas hooks updated to pass per-hook symbol manifests.
- **2026-05-18 atlas_paths bug fix-at-root:** two BLOCKING bugs in the Wave 1 Lane C symbol-manifest code, both fixed across the quartet — (1) `required_symbols` now resolves BOTH plain-module form (`lib/<name>.py`) AND package form (`lib/<name>/__init__.py`); previously only plain-module was probed, which silently fail-closed on any package-form manifest entry; (2) `_extract_module_symbols()` now returns `None` sentinel on parse/read error and `_path_satisfies()` treats `None` as inconclusive (skip symbol validation, presence check still gates), matching the documented "best-effort" fail-open contract; previously returned `frozenset()` which silently fail-closed every required symbol.
- **Mission Control dashboard:** the live CEO dashboard is `atlas-command` (separate repo, Next.js 15.3) reverse-proxied behind Caddy at https://atlas.gainpropertygroup.com/. As of 2026-05-01 the systemd `atlas-mission-control.service` runs `atlas-command` under user `nanoclaw-mc` (Wave 1.A.6 Phase 2). The unit file is no longer tracked in this repo's `infra/` — live config lives on the VPS at `/etc/systemd/system/atlas-mission-control.service`. The in-repo `mission-control/server.cjs` is DEPRECATED.

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js (orchestrator) + Python 3 (host-executor) |
| Language | TypeScript (orchestrator) + Python (hooks/host) |
| State store | SQLite (`src/db.ts`) for missions, tasks, audit |
| Channels | Telegram (Grammy), WhatsApp, Slack, Discord, Gmail — self-register at startup |
| Agent runtime | Claude Agent SDK inside Linux VMs (containers) |
| Container isolation | `--worktree` isolation for Tier 2+ tasks |
| Credentials | systemd `LoadCredential=` for `ANTHROPIC_API_KEY`; per-user SSH/OAuth |
| Service identity | `gateway` (legacy) → `nanoclaw-he` (Phase 3.2 in flight) |
| Dashboard | external `atlas-command` repo (Next.js 15.3), reverse-proxied via Caddy |

## Dependencies

- **Atlas paths quartet:** byte-identical `lib/atlas_paths.py` shared with atlas-engineering, atlas-operations, atlas-shared. Drift breaks production fail-close semantics.
- **VPS `/usr/local/lib/atlas`:** root-owned mirror of `~/.atlas/lib` populated by `git-sync.sh`. Module-level `_ATLAS_LIB_PATH` prefers this when complete.
- **Atlas Bridge** (HTTP): Paperclip integration, constraint enforcement, security evaluation. Missions traverse the bridge before approval.
- **Systemd:** `atlas-host-executor.service` (host-executor), `atlas-mission-control.service` (atlas-command dashboard), `nanoclaw` (orchestrator).
- **GitHub deploy keys** (Phase 3.2): two ed25519 keys, one per repo per GitHub policy. Replace the gateway-era shared key.
- **Sudoers grant:** `infra/sudoers.d/atlas-rsync` — narrow grant for `git-sync.sh` to rsync `~/.atlas/lib` → `/usr/local/lib/atlas`.

## Key Decisions

1. **Bridge-first mission architecture (v2.0.0).** Missions go through HTTP boundary before execution. Constraint enforcement and security evaluation live in the bridge, not duplicated in every container. Trade-off: bridge is a single point of failure — outages stall all mission approvals.
2. **Worktree isolation for parallel work (Tier 2+).** Containers run inside isolated git worktrees so parallel branches don't fight. Cleanup of stale worktrees is a known operational chore.
3. **`LoadCredential=` for Anthropic key (Phase 3.1).** Pulls the secret from a root-owned `/etc/atlas/anthropic-api-key.secret` (mode 0400) into the service's `$CREDENTIALS_DIRECTORY`. Service-account can't `cat` the secret file. Removes the env-var-leak vector.
4. **Production fail-close on path resolution (Phase 3.0).** When `ATLAS_HOST_MODE=production` the host-executor will not start unless every required Atlas path resolves. Replaces the "log and continue" behavior that masked broken installs.
5. **Dedicated `nanoclaw-he` POSIX user (Phase 3.2 in flight).** Splits the host-executor's identity from the legacy `gateway` user. Each service gets its own SSH + Claude OAuth + gitconfig home. Limits credential-blast-radius if one service is compromised.
6. **Mission Control moved to `atlas-command`.** This repo's `mission-control/server.cjs` is deprecated; the live dashboard is the separate `atlas-command` Next.js 15.3 app. Don't add features to the legacy server.

## Known Issues

- **Container build cache is sticky.** `--no-cache` does NOT invalidate COPY steps — the buildkit volume retains stale files. For a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
- **WhatsApp upgrades after a refactor:** WhatsApp is a separate channel fork now, not bundled in core. After core upgrade, run `/add-whatsapp` to reinstall.
- **`mission-control/server.cjs` still in the repo** but DEPRECATED. Live dashboard is `atlas-command` (separate repo). Don't extend the legacy server; PRs against it will get redirected.
- **Atlas-shared submodule pointer bumps** without pushing the pointed commit have caused review-time `not present in object database` failures in the past. Always push the submodule pointer before bumping its parent.

## What would make me worry

1. **`atlas_paths.py` quartet drift.** Four byte-identical copies live across atlas-engineering / atlas-operations / atlas-shared / nanoclaw. A one-off edit to any of them silently breaks the production fail-close contract (Phase 3.0) in only one of the four runtimes — and the cross-review hook only catches it on the repo where the edit landed. We have no automated cross-repo SHA check.
2. **Mission lifecycle stuck in `executing` or `synthesis` after a container crash.** If a container OOMs mid-mission and the cleanup path doesn't fire (which has happened during worktree-cleanup races), the SQLite row stays in `executing` forever. The CEO sees a stale "approved, running" mission with no actual process behind it. Manual SQL pokes are the only recovery path today.

## Telegram Commands

Handled mechanically in `src/commands.ts` — no LLM, no container, instant response.

| Command | Purpose |
|---------|---------|
| `/pause [taskId]` | Pause a scheduled task or all autonomous work |
| `/resume [taskId\|groupName]` | Resume paused task or auto-paused group |
| `/status` | Show task queue, graduation tier, quota usage, auto-pause state |
| `/approve [taskId]` | Approve a pending task in the approval queue |
| `/reject [taskId]` | Reject a pending task |
| `/quota` | Show quota usage breakdown (weighted units, model split, throttle state) |
| `/reset-mode` | Reset mode from paused/maintenance back to active |
| `/codex [on\|off]` | Toggle Codex delegation (on) or Claude subagents (off) |

## Governance Module (container/agent-runner/src/governance/)

Injected into every container session. Components:

- **Tier Gate** (`tier-gate.ts`): Maps graduation tier to available tools.
- **Quota** (`quota.ts`): Self-calibrating usage tracking. Model weights: haiku=0.1, sonnet=1.0, opus=5.0. Starts at 1000 weighted units/day estimate, adjusts from 429 responses.
- **Response Interceptor** (`response-interceptor.ts`): Haiku-based quality check on CEO-facing Telegram messages before delivery.
- **Canary** (`canary.ts`): Constitution validation at session start.
- **Audit** (`audit.ts`): Logs tool calls, governance events, post-task analysis.
- **Learning** (`learning.ts`): Post-task analysis for graduation credit.

## Host Executor (host/host-executor.py)

Runs on VPS host (not containerized). Watches `~/.atlas/host-tasks/pending/` for task JSON. Runs `claude -p` with tier-appropriate flags (Tier 2+ uses `--worktree`). Auto-pushes commits. Includes M2 graduation evaluation and self-healing for auth/outage failures. Systemd: `atlas-host-executor.service`.

## Safety Features

- **Auto-pause** (`src/auto-pause.ts`): Tracks consecutive failures per group. After threshold, pauses group and sends CEO Telegram alert. `/resume` clears.
- **Worktree isolation**: Tier 2+ tasks get isolated git worktrees. Branches merged back after completion.
- **Passive monitoring**: Staff group conversations evaluated after each exchange — surfaces approval needs, blockers, risks, wins for CEO.
- **Mechanical acks**: Valid Telegram messages get instant receive confirmation before container spawn. Denied senders get rejection messages.
- **Escalation alerts**: Staff containers write escalation files + IPC to atlas_main. CEO gets Telegram alert. File watcher as backup path.
- **SSRF protection**: Mission URLs validated against allowlist; private/loopback IPs blocked. Exact agent ID matching prevents tier-bypass via prefix collision. Atomic approve/reject with status pre-check.

## Group Architecture

Groups live in `groups/{name}/`. Each has `CLAUDE.md` (isolated memory) and `config.json`.

Shared workspaces (`~/.atlas/shared/`) provide cross-group coordination:
- Departments: marketing, operations, property-management, field-ops, executive
- Each has: `directives/` (CEO RO), `updates/` (staff RW), `briefs/` (CEO RO), `escalations/` (staff RW)

Self-knowledge (`~/.atlas/atlas-self-knowledge.md`) injected into container system prompts alongside global and group CLAUDE.md files.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development commands

```bash
npm run dev           # Orchestrator with hot reload
npm run build         # Compile TypeScript
./container/build.sh  # Rebuild agent container (prune buildkit first if COPY steps look stale)
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Skill routing (Claude Code only)

If the runtime is Claude Code and these skills are registered in the user's environment, prefer them for the following request types — otherwise ignore this section.

- Bugs / errors / "why is this broken" → `investigate`
- Ship / deploy / create PR → `ship`
- Code review → `review`
- Architecture review → `plan-eng-review`
- Code quality / health check → `health`
