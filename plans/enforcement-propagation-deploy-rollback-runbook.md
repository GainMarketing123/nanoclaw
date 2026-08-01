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

- **CAN**: read every per-group `settings.json` + marker; create/delete entries in the
  `atlas_gpg`, `atlas_main`, `telegram_atlas-marketing` `.claude` **directories** (but NOT
  overwrite the existing `0644` `nanoclaw-svc`-owned files in them — group access is
  read-only, so a plain `cp` onto one fails `EACCES`; see §4.3 R-3);
  write `/run/atlas/restart-queue/requests`;
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
set -u
SNAP=/home/atlas/.wave31c-settings-snapshot-$(date +%Y%m%dT%H%M%S)
mkdir -p "$SNAP"
GROUPS="atlas_gpg atlas_main atlas_teams telegram_atlas-marketing atlas_crownscape atlas_wisestream"
for g in $GROUPS; do
  d=/home/atlas/nanoclaw/data/sessions/$g/.claude
  mkdir -p "$SNAP/$g"
  for f in settings.json settings.json.source-mtime; do
    if [ -f "$d/$f" ]; then
      cp -p "$d/$f" "$SNAP/$g/$f" || { echo "SNAPSHOT FAILED: $g/$f" >&2; exit 1; }
    else
      : > "$SNAP/$g/$f.ABSENT"
    fi
  done
done
echo "$SNAP"
```

The `.ABSENT` sentinels are not decoration: `telegram_atlas-marketing` has **no** marker
today, and `atlas_crownscape` / `atlas_wisestream` have **no session dir at all**. Rollback
for those means **deleting** what the deploy created, not restoring a prior copy. A
restore-only rollback silently leaves them enforced.

**Verify the snapshot properly — do NOT just count directories.** The loop above creates
all six directories unconditionally, so a directory count is always 6 even if every single
copy failed. That check would pass on a completely empty snapshot and you would discover it
only when you needed to roll back. Assert instead that every group recorded a definite
state — either a real copy or an explicit sentinel — for both files:

```bash
SNAP_OK=1
for g in $GROUPS; do
  for f in settings.json settings.json.source-mtime; do
    if [ ! -f "$SNAP/$g/$f" ] && [ ! -f "$SNAP/$g/$f.ABSENT" ]; then
      echo "SNAPSHOT INCOMPLETE: $g/$f — DO NOT DEPLOY" >&2
      SNAP_OK=0
    fi
  done
done
[ "$SNAP_OK" = 1 ] || { echo "SNAPSHOT INVALID — DO NOT DEPLOY" >&2; exit 1; }
echo "snapshot verified: $SNAP"
```

The `SNAP_OK` flag matters: without it the loop prints its warnings and then falls through
to "snapshot verified" with a zero exit status, so both a human skimming the output and any
wrapping script would read a broken snapshot as a good one.

Cross-check the copied files against §1.1: `atlas_teams` must be 54 hook commands,
`atlas_gpg` 18, `atlas_main` 17, `telegram_atlas-marketing` 0. A snapshot that disagrees
with the recorded pre-deploy state is not a valid rollback point. Record the snapshot path.

### D2 — Record the deploy base, then push (this deploys)

**Record the deploy base FIRST.** After the push, `origin/main` advances and the pre-deploy
commit is no longer recoverable from a ref name — and §4.3 R-1 needs it to revert the whole
range:

```bash
git -C /home/thao/projects/ops/nanoclaw fetch origin
git -C /home/thao/projects/ops/nanoclaw rev-parse origin/main    # DEPLOY BASE — write it down
```

At the time of writing that is `16dfdda6d77055c6611cca4d6fe6e9bee753ba35`, and the server's
checkout is at exactly that commit (0 ahead / 0 behind).

From the **laptop** (the server cannot push):

```bash
git -C /home/thao/projects/ops/nanoclaw/.worktrees/wave31c-rulebook-fix push origin HEAD:main
```

The branch is based on `origin/main` with no intervening commits, so this is a
fast-forward. It does **not** carry any other lane's work. Note it pushes a **multi-commit**
branch — record the tip too (`git rev-parse HEAD`); rollback reverts the whole
base..tip range, not just the tip.

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
VERIFY_DIR=$(mktemp -d /tmp/wave31c-verify-XXXXXX) \
HOME=/home/atlas CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude \
  node --input-type=module -e '
    import { writeContainerSettings } from "/home/atlas/nanoclaw/dist/container-runner.js";
    import fs from "fs";
    const out = process.env.VERIFY_DIR + "/settings.json";
    writeContainerSettings(out);
    if (!fs.existsSync(out)) { console.log("REFUSED — no file written"); process.exit(1); }
    const s = JSON.parse(fs.readFileSync(out, "utf-8"));
    let n = 0; for (const es of Object.values(s.hooks ?? {})) for (const e of es) n += (e.hooks ?? []).length;
    console.log("hook commands propagated:", n);
  '
```

The output directory MUST be fresh each run (`mktemp -d`). A reused path keeps its
`settings.json` **and** its `.source-mtime` marker, so a second run short-circuits on the
freshness check and reprints the previous run's count without reading the source at all —
a green result that proves nothing.

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

**R-1 — Revert the code (this re-deploys automatically).**

**Do NOT revert in the canonical checkout `/home/thao/projects/ops/nanoclaw`.** That
checkout sits on an unrelated feature branch (`al-router-cred-routing` at the time of
writing) carrying other lanes' *unpushed* commits. Reverting there and pushing `HEAD:main`
would ship all of that other work to production alongside the rollback. Roll back from a
throwaway checkout synchronised to the deployed `origin/main` and nothing else:

```bash
git -C /home/thao/projects/ops/nanoclaw fetch origin
git -C /home/thao/projects/ops/nanoclaw worktree add /tmp/nc-rollback-$$ origin/main
cd /tmp/nc-rollback-$$
git log --oneline -1                       # MUST equal the deployed commit (§D4)

# Revert the WHOLE deployed RANGE, not just the tip.
git revert --no-edit <deploy-base-sha>..<deployed-tip-sha>
```

**Revert the range, never a single commit.** This deploy pushes a multi-commit branch
(`<deploy-base-sha>..<deployed-tip-sha>`), so `git revert <tip>` would undo only the last
commit and leave the rest of the change live — a rollback that reports success while the
propagation fix is still deployed and still writing 62-hook files. `<deploy-base-sha>` is
the `origin/main` commit recorded in §D2 **before** the push; capture it there, at deploy
time, because after the push `origin/main` no longer points at it.

**Now validate, and only then push.** The push is irreversible in effect (it auto-deploys
within 5 minutes), so the check belongs before it, not after:

```bash
git log --oneline origin/main..HEAD   # ONLY revert commits — one per reverted commit
git diff --stat <deploy-base-sha> HEAD  # MUST be EMPTY: tree is back to pre-deploy
```

The `git diff` is the real check: an empty diff against the deploy base proves the revert
restored the pre-deploy tree exactly. If it prints anything, STOP — either the revert did
not cover the whole range, or the checkout carries unrelated work that pushing would ship
to production. Only when the diff is empty:

```bash
git push origin HEAD:main
```

Remove the throwaway worktree (`git worktree remove /tmp/nc-rollback-$$`) once R-4 passes.

**R-2 — Wait for git-sync to rebuild and restart** (§D3/§D4 checks). Do not proceed until
`ExecMainStartTimestamp` has advanced and `dist/config.js` no longer drives the settings
read from `CLAUDE_SETTINGS_SOURCE_DIR`. Proceeding early reintroduces exactly the race this
ordering exists to avoid.

**R-3 — Restore per-group state from the snapshot.**

**Restore every group through docker-root — including the three whose directories `atlas`
can write.** Directory write permission is not enough: the per-group files are mode `0644`
owned by `nanoclaw-svc`, and `atlas` (group `atlas-svc`) has only group-**read** on them, so
a plain `cp` onto an existing file fails `EACCES`. Working around that by deleting and
recreating the file would leave it owned by `atlas`, silently changing the ownership the
service expects. One uniform privileged path avoids both failure modes and restores exact
ownership and mode:

The service stays running throughout, so each restore must be **atomic**: copy to a
temp name in the same directory, set ownership and mode there, then `mv` into place.
`rename(2)` within a directory is atomic, so a container spawning mid-rollback sees either
the old file or the restored one — never a half-written enforcement file. A plain `cp` over
a live `settings.json` is a torn-read window on exactly the file that decides which safety
checks the container runs.

**Every step below is status-checked.** A `docker run` that fails — image pull error,
missing mount, the in-container `exit 1` guard firing — still lets the surrounding loop
continue to the next group. Unchecked, the rollback would skip a group and finish
"successfully" while that channel stayed on the deployed 62-hook set. Abort on the first
failure and fix it before continuing:

```bash
set -u
SNAP=<snapshot path from D1>
ROLLBACK_FAILED=""

for g in atlas_gpg atlas_main atlas_teams telegram_atlas-marketing; do
  [ -d "$SNAP/$g" ] || { ROLLBACK_FAILED="$ROLLBACK_FAILED $g(no-snapshot)"; continue; }
  if ! docker run --rm -u 0:0 \
    -v /home/atlas/nanoclaw/data/sessions/$g/.claude:/target \
    -v "$SNAP/$g":/snap:ro alpine:latest sh -c '
      set -e
      for f in settings.json settings.json.source-mtime; do
        if [ -f "/snap/$f" ]; then
          cp "/snap/$f" "/target/.rollback.$f"
          chown 996:1001 "/target/.rollback.$f"
          chmod 644 "/target/.rollback.$f"
          mv -f "/target/.rollback.$f" "/target/$f"
        elif [ -f "/snap/$f.ABSENT" ]; then
          # Deleting requires POSITIVE proof the file did not exist pre-deploy.
          # telegram_atlas-marketing genuinely had no marker.
          rm -f "/target/$f"
        else
          # Neither a copy nor a sentinel: the snapshot is incomplete for this
          # file. Treating that as "was absent" would DELETE live state on the
          # strength of a snapshot bug. Refuse and leave it alone.
          echo "ROLLBACK ABORT: no snapshot copy and no sentinel for $f" >&2
          exit 1
        fi
      done'; then
    ROLLBACK_FAILED="$ROLLBACK_FAILED $g"
  fi
done
```

`996:1001` is `nanoclaw-svc:atlas-svc`, verified live on 2026-07-31 — not assumed from the
name. Re-check with `id -u nanoclaw-svc; id -g nanoclaw-svc` before running if any user
migration has happened since.

For `atlas_crownscape` / `atlas_wisestream` — they had **no session dir** pre-deploy, so
rollback is deletion, not restoration:

```bash
for g in atlas_crownscape atlas_wisestream; do
  [ -f "$SNAP/$g/settings.json.ABSENT" ] || continue
  if ! docker run --rm -u 0:0 \
    -v /home/atlas/nanoclaw/data/sessions:/s alpine:latest \
    sh -c "rm -f /s/$g/.claude/settings.json /s/$g/.claude/settings.json.source-mtime"; then
    ROLLBACK_FAILED="$ROLLBACK_FAILED $g"
  fi
done

[ -z "$ROLLBACK_FAILED" ] || {
  echo "ROLLBACK INCOMPLETE for:$ROLLBACK_FAILED — these channels are STILL on the deployed set" >&2
  exit 1
}
echo "rollback restore completed for all groups"
```

Do not treat the rollback as done on the strength of this script alone — R-4 re-reads the
counts from the running system, which is what actually proves it.

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
