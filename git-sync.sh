#!/bin/bash
# Atlas VPS Git Sync — pulls all project and config repos every 5 minutes
# Runs as atlas user via cron

LOG=/home/atlas/nanoclaw/logs/git-sync.log
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

sync_repo() {
    local dir="$1"
    local name="$2"
    if [ -d "$dir/.git" ]; then
        cd "$dir"
        result=$(git pull --rebase --autostash 2>&1)
        status=$?
        if [ $status -ne 0 ]; then
            echo "$TIMESTAMP | FAIL | $name | $result" >> "$LOG"
        elif [ "$result" != "Already up to date." ]; then
            echo "$TIMESTAMP | PULL | $name | $result" >> "$LOG"
        fi
    fi
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

  # --- atlas-host-executor restart (if host/ or infra/ changed) ---
  HOST_CHANGED=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- host/ infra/ 2>/dev/null)
  if [ -n "$HOST_CHANGED" ]; then
    echo "$TIMESTAMP | RESTART | atlas-host-executor | host/ or infra/ changed, restarting" >> "$LOG"
    sudo /usr/bin/systemctl restart atlas-host-executor.service
    sleep 3
    if systemctl is-active --quiet atlas-host-executor.service; then
      echo "$TIMESTAMP | RESTART | atlas-host-executor | service restarted successfully" >> "$LOG"
    else
      echo "$TIMESTAMP | FAIL | atlas-host-executor | service failed to start after restart" >> "$LOG"
    fi
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
    sync_repo /home/atlas/.atlas atlas-core
    # Phase 3.0 (1.A.6): mirror atlas lib to root-owned /usr/local/lib/atlas
    # after every atlas-core pull. Pre-cutover (directory absent), the
    # `[ -d ]` guard makes this a no-op so the script works on hosts that
    # haven't been upgraded yet. Sudoers entry at /etc/sudoers.d/atlas-rsync
    # (deployed as a Phase 3.0 cutover step from infra/sudoers.d/atlas-rsync)
    # gates the sudo call to this exact rsync command — atlas user has no
    # general sudo grant. host-executor.py prefers /usr/local/lib/atlas via
    # _ATLAS_LIB_PATH; if rsync fails the fallback at ATLAS_DIR/lib keeps
    # the service running while the failure is logged.
    if [ -d /usr/local/lib/atlas ]; then
        rsync_out=$(sudo rsync -a --delete /home/atlas/.atlas/lib/ /usr/local/lib/atlas/ 2>&1)
        rsync_status=$?
        if [ $rsync_status -ne 0 ]; then
            echo "$TIMESTAMP | FAIL | atlas-lib-sync | exit=$rsync_status $rsync_out" >> "$LOG"
        fi
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
