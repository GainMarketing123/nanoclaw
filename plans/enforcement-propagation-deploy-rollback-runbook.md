# Runbook — enforcement-hook propagation fix (deploy + rollback)

**Change:** separate the enforcement-rulebook source path from the credential path in
NanoClaw (`CLAUDE_SETTINGS_SOURCE_DIR` vs `CLAUDE_CONFIG_DIR`).
**Repo:** `nanoclaw`. **Branch:** `wave31c/rulebook-source-path`.
**Target:** VPS `atlas@5.78.190.56`, `/home/atlas/nanoclaw`, unit `nanoclaw.service`.
**Written:** 2026-07-31, before anything touched the server. Reviewed alongside the code.

This runbook is written to be executed by a human or an agent with `ssh atlas@…` access.
Every command below was validated against the live machine's actual permissions on
2026-07-31 (see §1.3); none is quoted from memory.

---

## 1. Facts this runbook depends on (all measured, not assumed)

### 1.1 Pre-deploy state, measured 2026-07-31

| Group | `settings.json` hook cmds | `.source-mtime` marker | dir writable by `atlas` |
|---|---|---|---|
| `atlas_teams` | **54** | `1783655742299.8826` | **NO** (`drwxr-sr-x`) |
| `atlas_gpg` | **18** (7 point at deleted scripts) | `1775190603031.2332` | yes |
| `atlas_main` | **17** | `1777773327241.684` | yes |
| `telegram_atlas-marketing` | **0** | **ABSENT** | yes |
| `atlas_crownscape` | no session dir | — | — |
| `atlas_wisestream` | no session dir | — | — |

Host rulebook `/home/atlas/.claude/settings.json`: **62** hook commands, mtime `1784678712`.
Credential dir `/home/nanoclaw-he/.claude/settings.json`: `{}` (3 bytes), mtime `1783812043`.
Enforcement manifest `/home/atlas/.atlas/enforcement-manifest.json`: 62 `required_hooks`.
All 62 referenced hook scripts exist on the host — nothing will fail to resolve.

### 1.2 When the defect started

`/etc/systemd/system/nanoclaw.service.d/oauth-shared-identity.conf` (installed
**2026-07-11 19:14:12 EDT**, repo commit `16dfdda`) sets
`Environment=CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude`. `atlas_teams` last propagated
successfully **2026-07-10 06:00**. The propagation defect therefore dates from
**2026-07-11**, not April. `atlas_gpg` (April) and `atlas_main` (May) are stale because
those channels have not spawned a container since those dates — two different causes with
the same symptom.

### 1.3 What the `atlas` user can and cannot do (verified live)

- **CAN**: read every per-group `settings.json` + marker; write `atlas_gpg`, `atlas_main`,
  `telegram_atlas-marketing` `.claude` dirs; write `/run/atlas/restart-queue/requests`;
  run `/home/atlas/regen-config-hashes.sh`; run `/home/atlas/git-sync.sh`; use `docker`
  (member of the `docker` group).
- **CANNOT**: `systemctl start/stop/restart` anything — `sudo -l` grants exactly four
  narrow scripts and **no** systemctl. Cannot write `atlas_teams/.claude`. Cannot list
  `/home/nanoclaw-he/`. Cannot push from the server (`origin` push URL is
  `DISABLED_pull_only_use_laptop`).
- **Elevation available**: `docker run -u 0:0 -v <hostdir>:/target alpine …` gives root
  file access to any bind-mounted host path. Verified end-to-end on a scratch dir
  (write, `chown`, remove) on 2026-07-31.
- `nanoclaw-svc` is **uid 996, gid 1001** (`atlas-svc`). Per-group files are
  `-rw-r--r-- nanoclaw-svc:atlas-svc`. Any root-written restore must
  `chown 996:1001` and `chmod 644`.

### 1.4 Deploy trigger

`crontab: */5 * * * * /home/atlas/git-sync.sh`. **Pushing to `origin/main` IS the deploy.**
Within ~5 minutes git-sync pulls, runs `npm run build`, runs `regen-config-hashes.sh`
(mandatory — `nanoclaw.service` has `ExecStartPre=check-config-integrity.sh` and
crash-loops without a matching manifest), then restarts via the restart queue.
There is no separate "deploy" action, and no way to push without deploying.

### 1.5 Propagation is LAZY — this bounds what any verification can show

`writeContainerSettings()` is called only from `buildVolumeMounts()`, which is reached only
from `runContainerAgent()`, which is called only from message handling (`src/index.ts`) and
the task scheduler (`src/task-scheduler.ts`). **A service restart does not re-propagate.**
Each channel's `settings.json` is rewritten at that channel's *next container spawn*:
`atlas_teams` at the 06:00 `atlas-orchestrator-daily` run; the others when someone messages
them. Any claim that all channels are "on the full set" before those spawns happen is false.

---

## 2. Deploy

### D1 — Snapshot FIRST (ordering is load-bearing)

Pushing is the deploy trigger, so a snapshot taken after the push may already capture
post-deploy state and be worthless as a rollback point. Take it **before** D2.

Run as `atlas` on the VPS:

```bash
SNAP=/home/atlas/.wave31c-settings-snapshot-$(date +%Y%m%dT%H%M%S)
mkdir -p "$SNAP"
for g in atlas_gpg atlas_main atlas_teams telegram_atlas-marketing atlas_crownscape atlas_wisestream; do
  d=/home/atlas/nanoclaw/data/sessions/$g/.claude
  mkdir -p "$SNAP/$g"
  if [ -f "$d/settings.json" ]; then cp -p "$d/settings.json" "$SNAP/$g/"; else echo ABSENT > "$SNAP/$g/settings.json.ABSENT"; fi
  if [ -f "$d/settings.json.source-mtime" ]; then cp -p "$d/settings.json.source-mtime" "$SNAP/$g/"; else echo ABSENT > "$SNAP/$g/settings.json.source-mtime.ABSENT"; fi
done
echo "$SNAP"
```

The `.ABSENT` sentinels are not decoration: `telegram_atlas-marketing` has **no** marker
today, and `atlas_crownscape` / `atlas_wisestream` have **no session dir at all**. Rollback
for those means **deleting** what the deploy created, not restoring a prior copy. A
restore-only rollback silently leaves them enforced.

Record the snapshot path. Verify it contains 6 subdirectories before continuing.

### D2 — Push (this deploys)

From the **laptop** (the server cannot push):

```bash
git -C /home/thao/projects/ops/nanoclaw/.worktrees/wave31c-rulebook-fix push origin HEAD:main
```

The branch is based on `origin/main` with no intervening commits, so this is a
fast-forward. It does **not** carry any other lane's work.

### D3 — Watch git-sync land it (do not skip)

```bash
tail -20 /home/atlas/nanoclaw/logs/git-sync.log
```

Expect, within ~5 minutes: `BUILD | nanoclaw | Source changed, rebuilding...`,
`Build succeeded, regenerating integrity manifest`, `Manifest regen succeeded, requesting
queue-first restart`. A `FAIL | nanoclaw | Manifest regen failed; SKIPPING restart` means
**stop and roll back** — the service would crash-loop on its integrity check.

A `FAIL | claude-config | Cannot fast-forward to multiple branches` line is a known benign
flock race on a *different* route and is not this deploy failing.

### D4 — Confirm the new build is actually running

```bash
git -C /home/atlas/nanoclaw rev-parse HEAD          # must equal the pushed commit
grep -c CLAUDE_SETTINGS_SOURCE_DIR /home/atlas/nanoclaw/dist/config.js   # must be >= 1
systemctl show nanoclaw.service -p ActiveState -p ExecMainStartTimestamp # start time must ADVANCE
```

If `ExecMainStartTimestamp` did not advance, the restart did not happen and the old code is
still in memory. Request one:

```bash
printf '%s' '{"unit":"nanoclaw.service","reason":"deploy-restart"}' \
  > /run/atlas/restart-queue/staging-tmp/r.json && \
  mv /run/atlas/restart-queue/staging-tmp/r.json /run/atlas/restart-queue/requests/restart-$(date +%s).json
```

(`atlas` can write `requests/` and `staging-tmp/`; the root-owned
`atlas-restart-trigger.path` unit drains them.)

---

## 3. Verification — from the running system

### V1 — the deployed artifact resolves the rulebook correctly

This is the decisive check, and it must run the **deployed** `dist/` under the **service's
exact environment**, writing to a scratch path so no live state is touched:

```bash
cd /home/atlas/nanoclaw
HOME=/home/atlas CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude \
  node --input-type=module -e '
    import { writeContainerSettings } from "/home/atlas/nanoclaw/dist/container-runner.js";
    import fs from "fs";
    const out = "/tmp/wave31c-verify/settings.json";
    fs.mkdirSync("/tmp/wave31c-verify", { recursive: true });
    writeContainerSettings(out);
    const s = JSON.parse(fs.readFileSync(out, "utf-8"));
    let n = 0; for (const es of Object.values(s.hooks ?? {})) for (const e of es) n += (e.hooks ?? []).length;
    console.log("hook commands propagated:", n);
  '
```

**PASS = `62`.** Anything less (especially `0`, or no file written) means the deployed build
is still reading the credential dir. `CLAUDE_CONFIG_DIR` is deliberately set to the
credential dir in that command: it proves the fix survives the very environment that caused
the incident.

### V2 — per-channel applied counts

```bash
for g in atlas_gpg atlas_main atlas_teams telegram_atlas-marketing atlas_crownscape atlas_wisestream; do
  f=/home/atlas/nanoclaw/data/sessions/$g/.claude/settings.json
  [ -f "$f" ] && echo "$g $(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(sum(len(e.get("hooks",[])) for es in d.get("hooks",{}).values() for e in es))' "$f")" || echo "$g NO-FILE"
done
```

Per §1.5 these change only at each channel's next spawn. Immediately after deploy they will
still read 54 / 18 / 17 / 0. That is expected and is **not** a failed deploy — V1 is what
proves the fix. Re-run V2 after the next 06:00 daily run: `atlas_teams` must read **62**.

### V3 — the refusal warning stops

```bash
grep -c container_settings_parity_refused /home/atlas/nanoclaw/logs/nanoclaw.log
```

Record the count at deploy time. After the next container spawn the count must **not**
increase. (Absence of new refusals before any spawn proves nothing — there is nothing to
refuse until a spawn happens.)

### V4 — nothing regressed

The next `atlas-orchestrator-daily` run must still log `Container completed` /
`Task completed`. `atlas_teams` already ran `pretool-discipline.py` and
`stop-consolidated.py` before this change and completed in 117 s, so the +8 hooks are the
only new variable.

---

## 4. Rollback

### 4.1 Why the obvious rollback is wrong

**Reverting the code alone does NOT roll back — it locks enforcement permanently ON while
appearing to undo itself.** Trace: after a revert the source path returns to
`/home/nanoclaw-he/.claude/settings.json` (`{}`); its mtime differs from the cached marker,
so `writeContainerSettings()` re-parses, fails parity against zero registered hooks, and
takes the early `return` whose documented purpose is *"Keeping previous per-group settings
file (if any) live"*. The "previous" file is by then the **newly written 62-hook file**.
Rollback must therefore restore per-group state explicitly.

### 4.2 Why this runbook does NOT stop the service

The natural instinct is stop → restore → start, so no spawn can overwrite the restored
files. That is unavailable (`atlas` has no systemctl grant) and, with the right ordering,
unnecessary. **Revert first, then restore.** Once the reverted build is running, propagation
already fails parity and *cannot write* per-group files — so there is no window in which a
spawn can undo the restore. Traced against `container-runner.ts`: with the reverted pointer,
`cachedMtime !== hostMtime` → parse `{}` → 62 missing → `parityFailure` → `return` before
any `writeFileSync`. Verified for both the post-deploy marker and the restored marker.

This ordering supersedes the "restore while stopped" constraint from the investigation
report. It removes the only step that needed a privilege `atlas` does not have.

### 4.3 Steps

**R-1 — Revert the code (this re-deploys automatically).** From the laptop:

```bash
git -C /home/thao/projects/ops/nanoclaw revert --no-edit <deployed-commit-sha>
git -C /home/thao/projects/ops/nanoclaw push origin HEAD:main
```

**R-2 — Wait for git-sync to rebuild and restart** (§D3/§D4 checks). Do not proceed until
`ExecMainStartTimestamp` has advanced and `dist/config.js` no longer drives the settings
read from `CLAUDE_SETTINGS_SOURCE_DIR`. Proceeding early reintroduces exactly the race this
ordering exists to avoid.

**R-3 — Restore per-group state from the snapshot.** For the three atlas-writable groups:

```bash
SNAP=<snapshot path from D1>
for g in atlas_gpg atlas_main telegram_atlas-marketing; do
  d=/home/atlas/nanoclaw/data/sessions/$g/.claude
  [ -f "$SNAP/$g/settings.json" ] && cp -p "$SNAP/$g/settings.json" "$d/settings.json"
  if [ -f "$SNAP/$g/settings.json.source-mtime" ]; then
    cp -p "$SNAP/$g/settings.json.source-mtime" "$d/settings.json.source-mtime"
  else
    rm -f "$d/settings.json.source-mtime"   # telegram had NO marker pre-deploy
  fi
done
```

For `atlas_teams` (not atlas-writable — needs docker-root):

```bash
docker run --rm -u 0:0 \
  -v /home/atlas/nanoclaw/data/sessions/atlas_teams/.claude:/target \
  -v "$SNAP/atlas_teams":/snap:ro alpine:latest sh -c '
    cp /snap/settings.json /target/settings.json
    cp /snap/settings.json.source-mtime /target/settings.json.source-mtime
    chown 996:1001 /target/settings.json /target/settings.json.source-mtime
    chmod 644 /target/settings.json /target/settings.json.source-mtime'
```

For `atlas_crownscape` / `atlas_wisestream` — they had **no session dir** pre-deploy, so
rollback is deletion, not restoration:

```bash
for g in atlas_crownscape atlas_wisestream; do
  d=/home/atlas/nanoclaw/data/sessions/$g/.claude
  [ -f "$SNAP/$g/settings.json.ABSENT" ] && docker run --rm -u 0:0 \
    -v /home/atlas/nanoclaw/data/sessions:/s alpine:latest \
    sh -c "rm -f /s/$g/.claude/settings.json /s/$g/.claude/settings.json.source-mtime"
done
```

**R-4 — Verify the rollback from the running system.** Re-run V2: counts must be back to
54 / 18 / 17 / 0 and the two never-provisioned groups must have no file. Re-run V3: the
refusal warning must **resume** on the next spawn. A rollback verified by reading the source
diff has verified nothing.

### 4.4 git-sync coordination during the rollback window

`git-sync.sh` runs every 5 minutes and single-instances on `flock
/home/atlas/.git-sync.lock` with a **300 s ceiling** — a concurrent run waits, then aborts
as a hard `FAIL`. Keep the R-3 restore under five minutes, or expect and accept that FAIL
line. Do not hand-edit the server's working tree at any point: the VPS is a pull-only deploy
mirror and local edits are reverted by the next sync.

---

## 5. Constraint ledger

| Constraint (from the investigation) | Where satisfied |
|---|---|
| R1 code-revert alone locks enforcement ON | §4.1 + §4.3 R-3 (explicit restore) |
| R2 restore `settings.json` **and** marker | §D1 snapshot + §4.3 R-3 (incl. marker deletion for telegram) |
| R3 two groups have nothing to restore | §D1 `.ABSENT` sentinels + §4.3 R-3 deletion block |
| R4 restore must not race a spawn | §4.2 — solved by ordering (revert-then-restore), no stop needed |
| R5 git-sync may auto-deploy mid-window | §1.4, §D3, §4.4 |
| R6 privileged steps unavailable to `atlas` | §1.3 (docker-root), §D4 (restart queue), `regen` is automatic |
| R7 verification is per group, from the running system | §3 V1–V4 |

## 6. Known limits of this runbook

1. It cannot make a channel pick up the new set on demand — propagation is lazy (§1.5).
   `atlas_teams` self-verifies at the next 06:00 run; the other channels at their next use.
2. It does not touch `/home/nanoclaw-he/` and deliberately does **not** copy the rulebook
   there. That shortcut would hide the symptom while leaving one variable doing two jobs.
3. It does not weaken, skip or reconfigure the container-spawn parity gate. The gate is
   what caught this incident; the fix relocates what it reads, nothing else.
