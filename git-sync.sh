#!/bin/bash
# Atlas VPS Git Sync — pulls all project and config repos every 5 minutes
# Runs as atlas user via cron

LOG=/home/atlas/nanoclaw/logs/git-sync.log
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

# Phase 3.1 prereq #2 (codex consult 2026-05-04, refined by d6faf12 R2 F2 SOFT
# 2026-05-05): sync_repo returns the pull's exit status so callers can gate
# downstream effects on a successful pull. Missing .git is treated as a no-op
# success (return 0) — codex named fix for d6faf12 F2: callers like the GPG
# loop unconditionally invoke sync_repo even when the repo isn't cloned, and
# returning failure for "no checkout" would make every cron cycle alarm even
# though no sync was attempted. Real failures (cd, pull) still propagate.
# Return contract:
#   0   = pull succeeded, "Already up to date.", OR no .git dir (no-op)
#   2   = cd failed (defensive — should never fire after .git guard)
#   N>0 = pull exit code (network/conflict/etc.)
sync_repo() {
    local dir="$1"
    local name="$2"
    if [ ! -d "$dir/.git" ]; then
        return 0
    fi
    if ! cd "$dir"; then
        echo "$TIMESTAMP | FAIL | $name | cd failed" >> "$LOG"
        return 2
    fi
    local result status
    result=$(git pull --rebase --autostash 2>&1)
    status=$?
    if [ $status -ne 0 ]; then
        echo "$TIMESTAMP | FAIL | $name | $result" >> "$LOG"
        return $status
    fi
    if [ "$result" != "Already up to date." ]; then
        echo "$TIMESTAMP | PULL | $name | $result" >> "$LOG"
    fi
    return 0
}

# NanoClaw — detect source changes, auto-rebuild and restart
NANOCLAW_DIR=/home/atlas/nanoclaw
if [ -d "$NANOCLAW_DIR/.git" ]; then
    cd "$NANOCLAW_DIR"
    HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null)
    sync_repo "$NANOCLAW_DIR" nanoclaw
    HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null)

    if [ "$HEAD_BEFORE" != "$HEAD_AFTER" ] && [ -n "$HEAD_BEFORE" ] && [ -n "$HEAD_AFTER" ]; then
        # Check if any source files changed (src/, container/, package.json, tsconfig)
        CHANGED_SRC=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- src/ container/ package.json tsconfig.json 2>/dev/null)
        if [ -n "$CHANGED_SRC" ]; then
            echo "$TIMESTAMP | BUILD | nanoclaw | Source changed, rebuilding..." >> "$LOG"
            BUILD_OUT=$(cd "$NANOCLAW_DIR" && npm run build 2>&1)
            BUILD_STATUS=$?
            if [ $BUILD_STATUS -eq 0 ]; then
                echo "$TIMESTAMP | BUILD | nanoclaw | Build succeeded, restarting service" >> "$LOG"
                sudo /usr/bin/systemctl restart nanoclaw
                sleep 3
                if systemctl is-active --quiet nanoclaw; then
                    echo "$TIMESTAMP | RESTART | nanoclaw | Service restarted successfully" >> "$LOG"
                else
                    echo "$TIMESTAMP | FAIL | nanoclaw | Service failed to start after rebuild" >> "$LOG"
                fi
            else
                echo "$TIMESTAMP | FAIL | nanoclaw | Build failed: ${BUILD_OUT:0:200}" >> "$LOG"
            fi
        fi

  # --- atlas-host-executor restart trigger (deferred) ---
  # Round-1 codex BLOCKING (e0b6fe0 F2): restarting here, BEFORE the atlas-core
  # pull + lib rsync below (line ~78+), would land the new host code against
  # the OLD atlas-core lib snapshot. host-executor.py resolves _ATLAS_LIB_PATH
  # ONCE at module import and then lazily imports atlas-lib modules during
  # task execution; once any module is imported, sys.modules caches it for
  # the process's lifetime. A restart here followed by an atlas-core lib
  # update would leave the running process using stale lib modules until
  # another restart. Defer the restart to AFTER atlas-core pull + rsync so
  # the new process imports against the fresh lib (whether served from
  # /usr/local/lib/atlas or ATLAS_DIR/lib fallback).
  HOST_CHANGED=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- host/ infra/ 2>/dev/null)
  if [ -n "$HOST_CHANGED" ]; then
    NEEDS_HOST_EXECUTOR_RESTART=1
    NEEDS_HOST_EXECUTOR_RESTART_REASON="nanoclaw host/ or infra/ changed"
    echo "$TIMESTAMP | DEFER_RESTART | atlas-host-executor | $NEEDS_HOST_EXECUTOR_RESTART_REASON" >> "$LOG"
  fi
  # MC_CHANGED restart block removed 2026-05-01: the legacy
  # mission-control/server.cjs deployment was deprecated, the
  # infra/atlas-mission-control.service unit was deleted from this repo
  # in the same commit, and the live atlas-mission-control deployment
  # now points at /home/atlas/atlas-command (which has its own
  # auto-pull + rebuild + restart block further down at the
  # "Atlas Command" section). See ~/.atlas/plans/1-a-6-host-executor-mission-control-audit.md
  # §11 (Wave 1.A.6 Phase 2 LANDED 2026-05-01) for full context.
    fi
fi

# Atlas core — graduation-status.json is written by the autonomous loop on VPS.
# Reset it before pull so upstream changes land cleanly. The autonomous loop
# will re-write the correct VPS state on its next run (daily at 10AM).
if [ -d /home/atlas/.atlas/.git ]; then
    cd /home/atlas/.atlas
    git checkout -- autonomy/graduation-status.json 2>/dev/null
    HEAD_BEFORE_AC=$(git rev-parse HEAD 2>/dev/null)
    # Phase 3.1 prereq (codex 0c77411 F1 + cb17ab2 R2 F1+F2 fixes): atlas lib
    # deployment with TWO independent restart triggers and a checked marker.
    #
    # Marker-based prod-tree mirroring: persistent tree-hash marker at
    # /home/atlas/.atlas/state/atlas-lib-rsync-tree records the lib/ tree
    # currently sitting in /usr/local/lib/atlas. Rsync runs whenever marker
    # disagrees with `git rev-parse HEAD:lib` — decouples deploy attempts
    # from pull-this-cycle outcomes (cycle-2 self-recovers if cycle-1's rsync
    # failed). Marker writes are checked at every step; any failure logs loud
    # and prevents the marker-advance restart from firing, so a stale marker
    # can't cause cron-loop-style repeated restarts every 5 minutes.
    #
    # Restart triggers (OR'd, dedup'd at the consolidated block below):
    #   (A) HEAD advanced AND lib/ changed in this cycle's pull. Fires
    #       regardless of prod-tree presence — covers pre-cutover hosts and
    #       degraded-prod hosts (resolver fell back to ATLAS_DIR/lib) where
    #       the running process's lib source just got new content.
    #   (B) Marker advanced this cycle off a non-empty prior value. Catches
    #       the cycle-2 deferred-recovery case (cycle-1 pulled new lib AND
    #       rsync failed; cycle-2 pull is no-op so (A) doesn't fire, but
    #       rsync re-attempts and on success the marker advances).
    if sync_repo /home/atlas/.atlas atlas-core; then
        HEAD_AFTER_AC=$(git rev-parse HEAD 2>/dev/null)
        # Tree hash is content-addressed: any lib/ change yields a new hash;
        # unrelated atlas-core changes don't. More precise than a commit-sha
        # marker.
        CURRENT_LIB_TREE=$(git rev-parse "HEAD:lib" 2>/dev/null || true)
        # Marker lives under atlas-writable state/ — no sudo needed, distinct
        # from the prod tree codex earlier consult ruled unsafe-to-write
        # (sudoers grants only the rsync command, no separate marker write
        # under /usr/local/lib/atlas).
        RSYNC_STATE_FILE=/home/atlas/.atlas/state/atlas-lib-rsync-tree
        LAST_RSYNCED_TREE=$(cat "$RSYNC_STATE_FILE" 2>/dev/null || true)
        rsync_status=0
        rsync_attempted=0
        marker_advanced=0
        # Marker-based mirroring (only runs when prod tree exists AND marker
        # disagrees with current lib tree). Pre-cutover hosts skip this whole
        # block and rely on trigger (A) below for restart on lib changes.
        if [ -d /usr/local/lib/atlas ] && [ -n "$CURRENT_LIB_TREE" ] && [ "$LAST_RSYNCED_TREE" != "$CURRENT_LIB_TREE" ]; then
            rsync_attempted=1
            rsync_out=$(sudo rsync -a --delete /home/atlas/.atlas/lib/ /usr/local/lib/atlas/ 2>&1)
            rsync_status=$?
            if [ $rsync_status -eq 0 ]; then
                # Codex cb17ab2 R2 F2 SOFT fix: each step checked. If any
                # write step fails, log loud and DO NOT set marker_advanced
                # — restart trigger (B) won't fire on a stale marker, which
                # would otherwise cause every cron cycle to redo the rsync
                # AND trigger a restart every 5 minutes.
                tmp_marker=""
                if mkdir -p "$(dirname "$RSYNC_STATE_FILE")" 2>/dev/null \
                   && tmp_marker=$(mktemp "$RSYNC_STATE_FILE.XXXXXX") \
                   && printf '%s\n' "$CURRENT_LIB_TREE" > "$tmp_marker" \
                   && mv "$tmp_marker" "$RSYNC_STATE_FILE"; then
                    marker_advanced=1
                else
                    echo "$TIMESTAMP | FAIL | atlas-lib-marker | failed to persist tree $CURRENT_LIB_TREE; rsync succeeded but marker not updated (next cycle will retry; rsync is idempotent)" >> "$LOG"
                    [ -n "$tmp_marker" ] && rm -f "$tmp_marker" 2>/dev/null || true
                fi
            else
                echo "$TIMESTAMP | FAIL | atlas-lib-sync | exit=$rsync_status $rsync_out" >> "$LOG"
                # Marker NOT updated — next cron cycle's tree-hash comparison
                # will see drift again and re-attempt automatically.
            fi
        fi
        # Restart trigger (A): HEAD advanced AND lib/ changed in this pull.
        # Fires regardless of prod-tree presence — codex cb17ab2 R2 F1
        # BLOCKING fix. Pre-fix, restart only fired on rsync success, leaving
        # pre-cutover (no prod tree) and degraded-prod (resolver fallback)
        # hosts with stale sys.modules indefinitely after lib changes.
        if [ "$HEAD_BEFORE_AC" != "$HEAD_AFTER_AC" ] && [ -n "$HEAD_BEFORE_AC" ] && [ -n "$HEAD_AFTER_AC" ]; then
            LIB_CHANGED=$(git diff --name-only "$HEAD_BEFORE_AC" "$HEAD_AFTER_AC" -- lib/ 2>/dev/null)
            if [ -n "$LIB_CHANGED" ]; then
                NEEDS_HOST_EXECUTOR_RESTART=1
                if [ -n "${NEEDS_HOST_EXECUTOR_RESTART_REASON:-}" ]; then
                    NEEDS_HOST_EXECUTOR_RESTART_REASON="$NEEDS_HOST_EXECUTOR_RESTART_REASON; atlas-core lib/ changed"
                else
                    NEEDS_HOST_EXECUTOR_RESTART_REASON="atlas-core lib/ changed"
                fi
                echo "$TIMESTAMP | DEFER_RESTART | atlas-host-executor | atlas-core lib/ changed (HEAD ${HEAD_BEFORE_AC:0:12} -> ${HEAD_AFTER_AC:0:12})" >> "$LOG"
            fi
        fi
        # Restart trigger (B): marker advanced this cycle off a non-empty
        # prior. Catches cycle-2 deferred-deploy recovery — codex 0c77411 R1 F1.
        # Bootstrap (LAST_RSYNCED_TREE empty) writes the marker without
        # restart; the operator-side Phase 3.0 cutover step list handles the
        # initial restart per commit 48fa247's runbook.
        if [ "$marker_advanced" -eq 1 ] && [ -n "$LAST_RSYNCED_TREE" ]; then
            NEEDS_HOST_EXECUTOR_RESTART=1
            if [ -n "${NEEDS_HOST_EXECUTOR_RESTART_REASON:-}" ]; then
                NEEDS_HOST_EXECUTOR_RESTART_REASON="$NEEDS_HOST_EXECUTOR_RESTART_REASON; atlas-core lib/ tree marker advanced"
            else
                NEEDS_HOST_EXECUTOR_RESTART_REASON="atlas-core lib/ tree marker advanced"
            fi
            echo "$TIMESTAMP | DEFER_RESTART | atlas-host-executor | atlas-core lib/ tree marker advanced ${LAST_RSYNCED_TREE:0:12} -> ${CURRENT_LIB_TREE:0:12}" >> "$LOG"
        fi
    else
        echo "$TIMESTAMP | SKIP | atlas-lib-sync | atlas-core sync_repo non-zero; marker unchanged, will retry next cycle" >> "$LOG"
    fi
fi

# --- Single deferred atlas-host-executor restart ---
# Round-1 codex BLOCKING (e0b6fe0 F1+F2): consolidated restart point.
# Triggers from BOTH nanoclaw host/infra changes AND atlas-core lib changes.
# Running here (after both pulls + rsync) ensures the restarted process sees
# fresh nanoclaw code AND fresh atlas-core lib in /usr/local/lib/atlas (or in
# the ATLAS_DIR/lib fallback). Single restart per cron cycle even if both
# repos changed — eliminates the mixed-version window where a restart on
# nanoclaw changes alone cached old atlas-core lib modules.
if [ "${NEEDS_HOST_EXECUTOR_RESTART:-0}" -eq 1 ]; then
    echo "$TIMESTAMP | RESTART | atlas-host-executor | $NEEDS_HOST_EXECUTOR_RESTART_REASON" >> "$LOG"
    sudo /usr/bin/systemctl restart atlas-host-executor.service
    sleep 3
    if systemctl is-active --quiet atlas-host-executor.service; then
        echo "$TIMESTAMP | RESTART | atlas-host-executor | service restarted successfully" >> "$LOG"
    else
        echo "$TIMESTAMP | FAIL | atlas-host-executor | service failed to start after restart" >> "$LOG"
    fi
fi

# Claude config (CLAUDE.md, hooks registration, planning docs, skills)
# settings.json has platform-specific paths — reset before pull, rewrite after.
if [ -d /home/atlas/.claude/.git ]; then
    cd /home/atlas/.claude
    git checkout -- settings.json 2>/dev/null
    sync_repo /home/atlas/.claude claude-config
    # Rewrite paths from laptop (Windows) to VPS (Linux)
    SETTINGS=/home/atlas/.claude/settings.json
    if [ -f "$SETTINGS" ] && grep -q 'C:/Users/ttle0' "$SETTINGS" 2>/dev/null; then
        sed -i 's|python C:/Users/ttle0/|python3 /home/atlas/|g' "$SETTINGS"
        echo "$TIMESTAMP | REWRITE | claude-config | settings.json paths translated to VPS" >> "$LOG"
    fi
fi

# Regenerate self-knowledge if atlas-core or claude-config pulled new changes
# (the regen script reads both repos' source files to build the summary)
if [ -f /home/atlas/.atlas/scripts/regen-self-knowledge.py ]; then
    python3 /home/atlas/.atlas/scripts/regen-self-knowledge.py >/dev/null 2>&1
fi

# Auto-detect cross-project relationships (shared Supabase, shared deps)
if [ -f /home/atlas/.atlas/scripts/regen-project-graph.py ]; then
    python3 /home/atlas/.atlas/scripts/regen-project-graph.py >/dev/null 2>&1
fi

# System health staleness detection (agent checksums, hook accuracy, registry currency)
if [ -f /home/atlas/.atlas/scripts/regen-system-health.py ]; then
    python3 /home/atlas/.atlas/scripts/regen-system-health.py >/dev/null 2>&1
fi

# Environment parity check (laptop vs VPS drift detection)
if [ -f /home/atlas/.atlas/scripts/check-env-parity.py ]; then
    python3 /home/atlas/.atlas/scripts/check-env-parity.py >/dev/null 2>&1
fi

# Prune stale worktrees from all project repos
for repo_dir in /home/atlas/projects/gpg/*/; do
    [ -d "$repo_dir/.git" ] && git -C "$repo_dir" worktree prune 2>/dev/null
done
for repo_dir in /home/atlas/projects/crownscape/*/; do
    [ -d "$repo_dir/.git" ] && git -C "$repo_dir" worktree prune 2>/dev/null
done

# GPG project repos
sync_repo /home/atlas/projects/gpg/monthly-reporting gpg/monthly-reporting
sync_repo /home/atlas/projects/gpg/ops-hub gpg/ops-hub
sync_repo /home/atlas/projects/gpg/social-post-studio gpg/social-post-studio

# Atlas Command — auto-pull + rebuild + restart on changes
ATLAS_CMD_DIR=/home/atlas/atlas-command
if [ -d "$ATLAS_CMD_DIR/.git" ]; then
    cd "$ATLAS_CMD_DIR"
    HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null)
    sync_repo "$ATLAS_CMD_DIR" atlas-command
    HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null)
    if [ "$HEAD_BEFORE" != "$HEAD_AFTER" ] && [ -n "$HEAD_BEFORE" ] && [ -n "$HEAD_AFTER" ]; then
        echo "$TIMESTAMP | BUILD | atlas-command | Source changed, rebuilding..." >> "$LOG"
        BUILD_OUT=$(cd "$ATLAS_CMD_DIR" && npm run build 2>&1)
        if [ $? -eq 0 ]; then
            # Guard the restart on unit being installed — fresh / partially
            # bootstrapped hosts may have atlas-command source pulled but
            # the systemd unit not yet installed (which lives outside this
            # repo's deploy artifacts). Cross-review of f23b1f7 caught
            # that `list-unit-files` returns 0 even for missing units — use
            # `systemctl cat` instead, which is a real existence probe (non-
            # zero on missing). Also check the restart's own exit code so
            # a failed restart logs FAIL rather than silently claiming
            # success.
            if systemctl cat atlas-mission-control.service >/dev/null 2>&1; then
                if sudo /usr/bin/systemctl restart atlas-mission-control; then
                    # systemctl restart returns 0 when the COMMAND succeeded,
                    # not when the service came up healthy. A unit that
                    # crashes during ExecStart can still produce a restart
                    # exit-code 0 within the first second. Poll for is-active
                    # with a bounded retry budget — fixed sleep would either
                    # misclassify slow starters as failed (too short) or
                    # waste cron-cycle time on fast starters (too long).
                    # ~10s ceiling at 0.5s resolution. Round-1 codex SOFT
                    # (27bc840) refinement of round-5 carry-over item 7.
                    RESTART_OK=false
                    for _ in $(seq 1 20); do
                        if systemctl is-active --quiet atlas-mission-control; then
                            RESTART_OK=true
                            break
                        fi
                        sleep 0.5
                    done
                    if $RESTART_OK; then
                        echo "$TIMESTAMP | BUILD | atlas-command | Build succeeded, restart OK" >> "$LOG"
                    else
                        echo "$TIMESTAMP | FAIL | atlas-command | Build succeeded, restart returned 0 but service did not become active within 10s" >> "$LOG"
                    fi
                else
                    echo "$TIMESTAMP | FAIL | atlas-command | Build succeeded but restart failed" >> "$LOG"
                fi
            else
                echo "$TIMESTAMP | BUILD | atlas-command | Build succeeded, unit not installed — skipping restart" >> "$LOG"
            fi
        else
            echo "$TIMESTAMP | FAIL | atlas-command | Build failed: ${BUILD_OUT:0:200}" >> "$LOG"
        fi
    fi
fi

# Crownscape project repos (nullglob so empty dirs don't produce a false iteration)
if [ -d /home/atlas/projects/crownscape ]; then
    shopt -s nullglob
    for dir in /home/atlas/projects/crownscape/*/; do
        [ -d "$dir/.git" ] && sync_repo "$dir" "crownscape/$(basename $dir)"
    done
    shopt -u nullglob
fi

# Heartbeat — log once per hour so VPS Atlas can confirm all routes are alive
# (cron runs every 5min; MINUTE<5 catches the :00 run each hour)
MINUTE=$(date +%M)
if [ "$MINUTE" -lt 5 ]; then
    ROUTES="nanoclaw atlas-core claude-config gpg/monthly-reporting gpg/ops-hub wisestream/social-post-studio crownscape/*"
    TIMESTAMP_NOW=$(date +%Y-%m-%dT%H:%M:%S%z)
    echo "$TIMESTAMP_NOW | HEARTBEAT | all | routes checked: $ROUTES" >> "$LOG"
fi
