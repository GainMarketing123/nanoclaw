#!/bin/bash
# Atlas VPS Git Sync — pulls all project and config repos every 5 minutes
# Runs as atlas user via cron

LOG=/home/atlas/nanoclaw/logs/git-sync.log
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)

# CO-1.A.6-FU-3 fix (2026-05-09): pre-fix `set -a; . /etc/atlas/atlas.env;
# set +a` shell-sourced the file, performing $VAR expansion and command
# substitution. systemd's EnvironmentFile= treats the same file as literal
# KEY=VALUE pairs only — no expansion, no command substitution. A value
# like `NANOCLAW_DIR=$HOME/nanoclaw` would resolve differently between cron
# (here) and systemd (the unit at infra/atlas-host-executor.service:61),
# recreating the split-brain that this shared file was meant to ELIMINATE.
# Original purpose preserved (codex 30f5e5f R1 F1 + d0d744d R1 F1 BLOCKING
# follow-up, 2026-05-08): source the same env file the systemd unit reads
# via EnvironmentFile=, BEFORE computing ATLAS_DIR/NANOCLAW_DIR below.
# Without this, an operator who sets ATLAS_DIR=/foo or NANOCLAW_DIR=/foo
# only on the systemd unit would see the service use /foo while cron still
# defaults to $HOME/.atlas — running services and the auto-sync/restart
# pipeline operating on different repos. Optional via test guard so this
# stays a no-op until /etc/atlas/atlas.env is created (matches the systemd
# unit's `EnvironmentFile=-/etc/atlas/atlas.env` leading-dash
# optional-load semantics).
#
# Strict parser matches the SUBSET of systemd EnvironmentFile= semantics
# operationally relevant to ATLAS_DIR / NANOCLAW_DIR (path values without
# escapes). Each rule below has a precise scope statement.
#
#   - Comments (`#` or `;` after whitespace strip), blank lines: skipped.
#   - Format: literal KEY=VALUE.
#   - KEY validated `[A-Za-z_][A-Za-z0-9_]*`. Bad keys logged + skipped.
#   - Leading whitespace on the line is stripped (matches systemd).
#   - Trailing whitespace on the value is stripped (matches systemd
#     unquoted-value behavior — codex e0085eb R2 BLOCKING #1 close
#     2026-05-09: pre-fix would export `ATLAS_DIR=/srv/atlas   ` while
#     systemd would store `/srv/atlas`, recreating split-brain).
#   - Surrounding single OR double quotes stripped before export (matches
#     systemd quote-strip semantics for the value's outer wrapper).
#   - Line continuations (trailing `\` before newline) REJECTED with FAIL
#     log line. systemd accepts them; we deliberately don't, because
#     ATLAS_DIR/NANOCLAW_DIR are short path values that never need
#     continuation. Documented limitation, not silent drift.
#   - VALUE CONTENTS are exported via `export "$key=$value"` which does
#     NOT re-expand `$VAR`, backtick, or backslash inside the value
#     string (bash double-quoted-variable expansion is one-pass). So
#     literal `$`, backtick, and backslash in the value are stored
#     verbatim — matching systemd's literal-storage of the same input.
#     Codex e0085eb R2 BLOCKING #2 close 2026-05-09: pre-fix blanket-
#     rejected backslash assuming bash would expand it; the parser
#     architecture already prevents that, so the rejection silently
#     dropped values systemd would have honored. Rejection removed.
#   - DOCUMENTED SCOPE LIMITATION: double-quoted values with C-style
#     escapes (`"foo\nbar"`) are stored as literal `foo\nbar` here while
#     systemd would interpret `\n` as newline. ATLAS_DIR / NANOCLAW_DIR
#     are absolute path strings, never containing C-escapes; this drift
#     surface is theoretical for the operational scope. If a future
#     consumer needs C-escape interpretation, parsing should move to a
#     Python helper that fully implements systemd grammar — out of scope
#     for path-only ATLAS_DIR / NANOCLAW_DIR consumption.
#
# A malformed line skips that single assignment but leaves cron running
# (defensive — an env-file typo shouldn't kill the whole sync pipeline;
# downstream defaults exist for ATLAS_DIR/NANOCLAW_DIR below).
if [ -r /etc/atlas/atlas.env ]; then
    # `|| [ -n "$line" ]` runs the loop body once more for a final line
    # that lacks a trailing newline. Codex a988431 R1 BLOCKING (2026-05-09):
    # systemd's EnvironmentFile= STILL loads that unterminated last line,
    # so dropping it here recreates the cron-vs-systemd split-brain this
    # parser was built to eliminate (e.g. final-line `ATLAS_DIR=/srv/atlas`
    # would be honored by systemd while cron silently fell back to
    # $HOME/.atlas — running services and the auto-sync pipeline against
    # different trees).
    while IFS= read -r line || [ -n "$line" ]; do
        # Strip leading whitespace via parameter-expansion glob trick
        line="${line#"${line%%[![:space:]]*}"}"
        # Skip blanks and comments
        case "$line" in
            ''|'#'*|';'*) continue ;;
        esac
        # Reject line continuations (systemd supports, we don't)
        case "$line" in
            *\\) echo "$TIMESTAMP | FAIL | atlas.env | line continuation not supported: ${line:0:80}" >> "$LOG"; continue ;;
        esac
        # Must contain `=`
        case "$line" in
            *=*) ;;
            *) echo "$TIMESTAMP | FAIL | atlas.env | not KEY=VALUE: ${line:0:80}" >> "$LOG"; continue ;;
        esac
        key="${line%%=*}"
        value="${line#*=}"
        # Codex 6ba4a92 R1 BLOCKING close (2026-05-12): strip whitespace AROUND
        # the `=` separator before whitelist + key validation. Pre-fix, a line
        # like `ATLAS_DIR = /srv/atlas` would split into key=`ATLAS_DIR ` (with
        # trailing space) — the trailing-space key falls through the whitelist
        # and key-validation as a silent skip rather than being normalized.
        # Symmetric pre-fix vector: `ATLAS_DIR= /srv/atlas` exported the raw
        # value with a leading space, since the value-trailing-whitespace strip
        # at line ~123 below only handled the trailing end. Mirror systemd
        # EnvironmentFile= behavior which tolerates whitespace around `=`.
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"
        # Codex bcabb38 R2 SOFT close (2026-05-09): whitelist the keys this
        # script consumes (ATLAS_DIR, NANOCLAW_DIR). Without the whitelist,
        # any service-only var placed in /etc/atlas/atlas.env (PATH, HOME,
        # GIT_DIR, NODE_OPTIONS, PYTHONPATH, ...) would propagate into the
        # cron environment and silently alter every later git/npm/python3
        # subprocess in this script. The shared file's intent is checkout-
        # root parity for the host-executor service; cron does NOT need
        # any other variable from it.
        case "$key" in
            ATLAS_DIR|NANOCLAW_DIR) ;;
            *) echo "$TIMESTAMP | INFO | atlas.env | key not whitelisted, skipped: $key" >> "$LOG"; continue ;;
        esac
        # Strip trailing whitespace from value (codex e0085eb R2 BLOCKING #1 close,
        # matches systemd unquoted-value behavior — pre-fix exported the raw value
        # including trailing spaces while systemd stripped them, recreating the
        # split-brain on `ATLAS_DIR=/srv/atlas   ` style entries).
        # `${value##*[![:space:]]}` returns the trailing-whitespace-only suffix
        # of the value (everything after the last non-whitespace character);
        # `${value%"<that suffix>"}` strips it from the end.
        value="${value%"${value##*[![:space:]]}"}"
        # Validate KEY: [A-Za-z_][A-Za-z0-9_]*
        case "$key" in
            ''|[0-9]*|*[!A-Za-z0-9_]*) echo "$TIMESTAMP | FAIL | atlas.env | invalid key: $key" >> "$LOG"; continue ;;
        esac
        # NOTE: $ / backtick / backslash inside values are NOT rejected (codex
        # e0085eb R2 BLOCKING #2 close 2026-05-09). `export "$key=$value"` below
        # uses bash one-pass double-quoted-variable expansion which does NOT
        # re-expand the value's contents, so literal `$`, backtick, and `\` are
        # stored verbatim — matching systemd's literal-storage of the same input.
        # The pre-fix blanket-rejection was based on the wrong mental model
        # (sourced shell expansion) and silently dropped values systemd honored.
        # Strip surrounding single or double quotes (matches systemd literal-quotes semantics)
        case "$value" in
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
        esac
        export "$key=$value"
    done < /etc/atlas/atlas.env
fi

# Codex 5e17091 R2 BLOCKING follow-up: parameterize ATLAS_DIR rather than
# hardcoding /home/atlas/.atlas. host-executor.py uses ATLAS_DIR via the
# shared lib/atlas_paths.env_or_home("ATLAS_DIR", ".atlas", strict=...)
# helper as the canonical atlas-core checkout path, supporting an env-var
# override. This script previously hardcoded /home/atlas/.atlas, which on
# any host where ATLAS_DIR points elsewhere would cause: (a) atlas-core
# presence check false-negative → ATLAS_CORE_PRESENT=0, (b) the bottom-gate
# restart fires treating "absent" as safe even though the executor IS using
# a real atlas-core checkout that wasn't synced this cycle. Default matches
# host-executor.py's default ($HOME/.atlas → /home/atlas/.atlas for the
# atlas user); allow the same env-var override host-executor.py honors so
# both consumers resolve the same path on any deployment.
ATLAS_DIR="${ATLAS_DIR:-$HOME/.atlas}"

# C2 + R1 codex 5955b3c follow-up — atlas-core restart-safety tri-state.
#
# Original C2 problem (codex 0ba5abf R4 F2 BLOCKING): pre-C2 default of 1
# meant a host WITHOUT atlas-core cloned (the `[ -d /home/atlas/.atlas/.git ]`
# guard at line ~110 skips the entire atlas-core block, never setting the
# flag) still had the consolidated restart fire, restarting host-executor
# against an atlas-lib it couldn't load.
#
# Round-1 follow-up (codex 5955b3c BLOCKING — same architectural area, NEW
# scenario): a default of 0 fail-closes correctly when atlas-core is present
# but its sync failed, BUT it ALSO suppresses restart on legitimate hosts
# where ATLAS_DIR is overridden via the systemd env var to a path other than
# /home/atlas/.atlas (host-executor.py line 64 supports this). On such
# hosts: (a) git-sync.sh still hard-codes the .git existence check at
# /home/atlas/.atlas, (b) the atlas-core block stays skipped, (c) host-
# executor.py runs fine using the overridden ATLAS_DIR/lib fallback, but
# (d) nanoclaw host code changes never trigger restart — the running
# process keeps executing stale Python indefinitely.
#
# Tri-state guard distinguishes "atlas-core ABSENT" from "atlas-core
# PRESENT but sync FAILED":
#   ATLAS_CORE_PRESENT=0 → no /home/atlas/.atlas/.git on this host
#                          (set/cleared at the line ~110 guard)
#   ATLAS_CORE_PRESENT=1 → /home/atlas/.atlas/.git exists; pair with:
#     ATLAS_CORE_SYNC_OK=1 → this cycle's pull succeeded
#     ATLAS_CORE_SYNC_OK=0 → this cycle's pull failed OR not yet attempted
#
# Bottom-gate restart logic (line ~265):
#   restart_safe := (ATLAS_CORE_PRESENT == 0) || (ATLAS_CORE_SYNC_OK == 1)
# i.e., restart unless atlas-core is present-but-failed-this-cycle.
ATLAS_CORE_PRESENT=0
ATLAS_CORE_SYNC_OK=0

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
#
# Codex b137484 R1 F2 BLOCKING follow-up (2026-05-08): parameterize
# NANOCLAW_DIR the same way ATLAS_DIR is parameterized at line 20 above.
# host/host-executor.py now reads NANOCLAW_DIR via lib/atlas_paths.env_or_home
# (overrideable via systemd EnvironmentFile=), so this script must respect the
# same override or cron will sync/build/restart against /home/atlas/nanoclaw
# while host-executor reads IPC, DB, and quality-check prompt files from a
# different override checkout — leaving the running services on stale code
# indefinitely. Default matches host-executor.py's default ($HOME/nanoclaw →
# /home/atlas/nanoclaw for the atlas user).
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
if [ -d "$NANOCLAW_DIR/.git" ]; then
    cd "$NANOCLAW_DIR"
    HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null)
    # Codex 6282087 R3 F2 BLOCKING fix: gate HEAD_AFTER/diff/build/restart on
    # successful pull. Pre-fix, a failed rebase could leave the repo mid-rebase
    # or partially advanced, and HEAD_AFTER != HEAD_BEFORE would still run npm
    # build + service restart from a conflicted/incomplete tree. Match the
    # atlas-core pattern (`if sync_repo ...; then ... else log skip ... fi`).
    if sync_repo "$NANOCLAW_DIR" nanoclaw; then
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
                # C1 collateral fix (codex 0ba5abf R4 F1 BLOCKING — same
                # pattern surfaced during atlas-host-executor restart guard
                # work): gate the is-active probe on the systemctl restart's
                # own exit code. Pre-fix, a non-zero restart (sudoers /
                # unit-load / bus errors) still dropped into the is-active
                # check, which could read the OLD running unit as active and
                # emit a false-success RESTART log line. Mirroring the
                # atlas-mission-control block below at lines ~364-380.
                if sudo /usr/bin/systemctl restart nanoclaw; then
                    sleep 3
                    if systemctl is-active --quiet nanoclaw; then
                        echo "$TIMESTAMP | RESTART | nanoclaw | Service restarted successfully" >> "$LOG"
                    else
                        echo "$TIMESTAMP | FAIL | nanoclaw | Service failed to start after rebuild (post-restart is-active check)" >> "$LOG"
                    fi
                else
                    echo "$TIMESTAMP | FAIL | nanoclaw | systemctl restart failed (non-zero exit; check journalctl for unit-load / sudoers / bus errors)" >> "$LOG"
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
  # Codex 30f5e5f R1 F3 BLOCKING follow-up (2026-05-08): include lib/ in the
  # restart-trigger diff set. host/host-executor.py:67 imports env_or_home
  # from lib/atlas_paths.py during module init, so a future pull that changes
  # only lib/ would land on disk without restarting the long-running service —
  # the old in-memory helper would keep executing indefinitely. The atlas-lib
  # mirror that already triggers the bottom-gate restart at line ~265 covers
  # changes from atlas-engineering's lib/, but THIS lib/ is nanoclaw's own
  # bootstrap-shim copy of atlas_paths.py and needs its own restart signal.
  HOST_CHANGED=$(git diff --name-only "$HEAD_BEFORE" "$HEAD_AFTER" -- host/ infra/ lib/ 2>/dev/null)
  if [ -n "$HOST_CHANGED" ]; then
    NEEDS_HOST_EXECUTOR_RESTART=1
    NEEDS_HOST_EXECUTOR_RESTART_REASON="nanoclaw host/ or infra/ or lib/ changed"
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
    else
        echo "$TIMESTAMP | SKIP | nanoclaw | sync_repo non-zero; skipping rebuild + host-executor restart trigger" >> "$LOG"
    fi
fi

# Atlas core — graduation-status.json is written by the autonomous loop on VPS.
# Reset it before pull so upstream changes land cleanly. The autonomous loop
# will re-write the correct VPS state on its next run (daily at 10AM).
if [ -d "$ATLAS_DIR/.git" ]; then
    # Tri-state guard (codex 5955b3c R1 + 5e17091 R2 BLOCKING): mark atlas-
    # core as PRESENT on this host (resolved via $ATLAS_DIR — same source
    # host-executor.py uses) so the bottom-gate restart logic distinguishes
    # "atlas-core repo absent (no atlas-core at the resolved ATLAS_DIR)"
    # from "atlas-core present-but-failed-to-sync (unsafe to restart against
    # potentially-stale lib)". See top-of-script comment on ATLAS_DIR +
    # ATLAS_CORE_PRESENT for full rationale.
    ATLAS_CORE_PRESENT=1
    cd "$ATLAS_DIR"
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
    if sync_repo "$ATLAS_DIR" atlas-core; then
        ATLAS_CORE_SYNC_OK=1
        HEAD_AFTER_AC=$(git rev-parse HEAD 2>/dev/null)
        # Tree hash is content-addressed: any lib/ change yields a new hash;
        # unrelated atlas-core changes don't. More precise than a commit-sha
        # marker.
        CURRENT_LIB_TREE=$(git rev-parse "HEAD:lib" 2>/dev/null || true)
        # Marker lives under atlas-writable state/ — no sudo needed, distinct
        # from the prod tree codex earlier consult ruled unsafe-to-write
        # (sudoers grants only the rsync command, no separate marker write
        # under /usr/local/lib/atlas).
        RSYNC_STATE_FILE="$ATLAS_DIR/state/atlas-lib-rsync-tree"
        LAST_RSYNCED_TREE=$(cat "$RSYNC_STATE_FILE" 2>/dev/null || true)
        rsync_status=0
        rsync_attempted=0
        marker_advanced=0
        # Marker-based mirroring (only runs when prod tree exists AND marker
        # disagrees with current lib tree). Pre-cutover hosts skip this whole
        # block and rely on trigger (A) below for restart on lib changes.
        if [ -d /usr/local/lib/atlas ] && [ -n "$CURRENT_LIB_TREE" ] && [ "$LAST_RSYNCED_TREE" != "$CURRENT_LIB_TREE" ]; then
            rsync_attempted=1
            # -aL (follow symlinks): de-symlink the lib tree into prod so the
            # `providers` package + other shared/lib-targeted symlinks resolve
            # as REAL files in /usr/local/lib/atlas. Under plain -a they were
            # copied as symlinks pointing at ../shared/lib/X, which dangle in
            # prod (shared/ is not mirrored there) — so the prod-tree probe
            # failed and the resolver silently fell back to the user-writable
            # tree. Required for the prod tree to be selectable once the
            # fail-closed resolver (_fallback_or_die) is live. LOCKSTEP: the
            # sudoers grant (infra/sudoers.d/atlas-rsync) pins the exact rsync
            # command and MUST be updated to -aL together with this line, or the
            # NOPASSWD match breaks and the mirror prompts for a password.
            if [ "$ATLAS_DIR/lib/" != "/home/atlas/.atlas/lib/" ]; then
                echo "$TIMESTAMP | WARN | atlas-lib-sync | rsync source $ATLAS_DIR/lib/ does not match the sudoers-pinned /home/atlas/.atlas/lib/ (infra/sudoers.d/atlas-rsync); the NOPASSWD match will break and the mirror below will fail (sudo cannot prompt under cron). Update the sudoers grant in lockstep before overriding ATLAS_DIR, or the prod tree goes stale and host-executor fail-closes on restart." >> "$LOG"
            fi
            rsync_out=$(sudo rsync -aL --delete "$ATLAS_DIR/lib/" /usr/local/lib/atlas/ 2>&1)
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
        elif [ ! -d /usr/local/lib/atlas ] && [ -f "$RSYNC_STATE_FILE" ]; then
            # Prod tree previously mirrored (marker exists) but the dir is now
            # gone — this host WAS cut over. Under ATLAS_HOST_MODE=production the
            # fail-closed resolver (_fallback_or_die) will SystemExit on the next
            # restart. Log loud; recreation is intentionally NOT attempted here.
            echo "$TIMESTAMP | FAIL | atlas-lib-sync | /usr/local/lib/atlas missing but rsync marker $RSYNC_STATE_FILE exists (host was cut over); host-executor will fail-closed on restart under production. Recreate the prod tree (see infra/sudoers.d/atlas-rsync header)." >> "$LOG"
        fi
        # Restart trigger (A): HEAD advanced AND lib/ changed in this pull.
        # Codex 6282087 R3 F1 BLOCKING fix: trigger (A) only fires when the
        # content the restarted process will see is fresh.
        #   - prod tree absent → fallback gets the freshly-pulled lib → safe.
        #   - prod tree present AND rsync succeeded → prod has fresh lib → safe.
        #   - prod tree present AND rsync didn't succeed → prod is stale; the
        #     resolver (probe-import passes on stale-but-valid trees) would
        #     pick prod over fallback, leaving the restarted process on old
        #     code while new host code expects new library APIs. Skip restart
        #     this cycle; trigger (B) will fire on a later cycle whose rsync
        #     succeeds (marker-advance).
        # Per spec-spiral cap on this architectural area (R3 walk-back limit
        # 2026-05-05), keeping the fix surgical: gate the trigger rather than
        # introduce resolver-side freshness checks. Resolver-side check would
        # be the broader fix but expands resolver scope past what this arc
        # can converge on within the cap.
        if [ "$HEAD_BEFORE_AC" != "$HEAD_AFTER_AC" ] && [ -n "$HEAD_BEFORE_AC" ] && [ -n "$HEAD_AFTER_AC" ]; then
            LIB_CHANGED=$(git diff --name-only "$HEAD_BEFORE_AC" "$HEAD_AFTER_AC" -- lib/ 2>/dev/null)
            if [ -n "$LIB_CHANGED" ]; then
                if [ ! -d /usr/local/lib/atlas ] || { [ "$rsync_attempted" -eq 1 ] && [ "$rsync_status" -eq 0 ]; }; then
                    NEEDS_HOST_EXECUTOR_RESTART=1
                    if [ -n "${NEEDS_HOST_EXECUTOR_RESTART_REASON:-}" ]; then
                        NEEDS_HOST_EXECUTOR_RESTART_REASON="$NEEDS_HOST_EXECUTOR_RESTART_REASON; atlas-core lib/ changed"
                    else
                        NEEDS_HOST_EXECUTOR_RESTART_REASON="atlas-core lib/ changed"
                    fi
                    echo "$TIMESTAMP | DEFER_RESTART | atlas-host-executor | atlas-core lib/ changed (HEAD ${HEAD_BEFORE_AC:0:12} -> ${HEAD_AFTER_AC:0:12})" >> "$LOG"
                else
                    echo "$TIMESTAMP | SKIP_RESTART | atlas-host-executor | atlas-core lib/ changed but prod tree not freshly synced (rsync_attempted=$rsync_attempted rsync_status=$rsync_status); deferring to a cycle whose rsync succeeds" >> "$LOG"
                fi
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
        ATLAS_CORE_SYNC_OK=0
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
    # Codex 4ccb79b R4 F1 BLOCKING fix: only restart when atlas-core sync was
    # known-good for this cycle. Pre-fix, a nanoclaw host/infra change set
    # NEEDS_HOST_EXECUTOR_RESTART=1 BEFORE the atlas-core pull at line ~107;
    # if atlas-core then failed, the consolidated restart still ran and the
    # restarted host-executor.py resolved _ATLAS_LIB_PATH against stale
    # atlas-lib (atlas-core didn't pull) while running newly-pulled host
    # code, surfacing as ImportError or mixed-version behavior at task time.
    #
    # Tri-state restart-safety guard (codex 5955b3c R1 BLOCKING):
    #   ATLAS_CORE_PRESENT=0 → atlas-core repo not on this host (legitimate
    #     pre-cutover / overridden-ATLAS_DIR scenario per host-executor.py
    #     lines 64-69 + 143-146 — host-executor falls back to ATLAS_DIR/lib).
    #     Restart IS appropriate for nanoclaw host code changes.
    #   ATLAS_CORE_PRESENT=1 + ATLAS_CORE_SYNC_OK=1 → repo present, this
    #     cycle's pull succeeded. Restart appropriate.
    #   ATLAS_CORE_PRESENT=1 + ATLAS_CORE_SYNC_OK=0 → repo present, this
    #     cycle's pull failed. Restart UNSAFE (mixed-version window).
    # Restart safe iff: atlas-core ABSENT, OR (atlas-core PRESENT AND sync OK).
    if [ "${ATLAS_CORE_PRESENT:-0}" -eq 0 ] || [ "${ATLAS_CORE_SYNC_OK:-0}" -eq 1 ]; then
        echo "$TIMESTAMP | RESTART | atlas-host-executor | $NEEDS_HOST_EXECUTOR_RESTART_REASON" >> "$LOG"
        # C1 fix (codex 0ba5abf R4 F1 BLOCKING): gate the is-active probe on
        # the systemctl restart's own exit code. Pre-fix, a non-zero
        # `systemctl restart` (e.g., systemd unit-load failure, transient
        # bus fault, sudoers misconfig) would still drop into `sleep 3 +
        # systemctl is-active`, which could report the OLD running unit as
        # active and emit a false-success RESTART line. Mirroring the
        # atlas-command block at lines ~322-340 below — `if sudo systemctl
        # restart ...; then ... else log FAIL ...; fi`.
        if sudo /usr/bin/systemctl restart atlas-host-executor.service; then
            sleep 3
            if systemctl is-active --quiet atlas-host-executor.service; then
                echo "$TIMESTAMP | RESTART | atlas-host-executor | service restarted successfully" >> "$LOG"
            else
                echo "$TIMESTAMP | FAIL | atlas-host-executor | service failed to start after restart (post-restart is-active check)" >> "$LOG"
            fi
        else
            echo "$TIMESTAMP | FAIL | atlas-host-executor | systemctl restart failed (non-zero exit; check journalctl for unit-load / sudoers / bus errors)" >> "$LOG"
        fi
    else
        echo "$TIMESTAMP | SKIP_RESTART | atlas-host-executor | flag set ($NEEDS_HOST_EXECUTOR_RESTART_REASON) but atlas-core present-and-sync-failed this cycle (PRESENT=$ATLAS_CORE_PRESENT SYNC_OK=$ATLAS_CORE_SYNC_OK); deferring to next cycle to avoid stale-lib mixed-version window" >> "$LOG"
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
# Codex 4588f4e R3 F2 SOFT fix: quote $ATLAS_DIR expansions everywhere it
# appears in test/argv positions. Pre-fix, an override containing
# whitespace or shell metacharacters (rare but legitimate, e.g.
# /opt/atlas\ checkout) would word-split the path under [ -f ... ] and
# python3 invocations.
if [ -f "$ATLAS_DIR/scripts/regen-self-knowledge.py" ]; then
    python3 "$ATLAS_DIR/scripts/regen-self-knowledge.py" >/dev/null 2>&1
fi

# Auto-detect cross-project relationships (shared Supabase, shared deps)
if [ -f "$ATLAS_DIR/scripts/regen-project-graph.py" ]; then
    python3 "$ATLAS_DIR/scripts/regen-project-graph.py" >/dev/null 2>&1
fi

# System health staleness detection (agent checksums, hook accuracy, registry currency)
if [ -f "$ATLAS_DIR/scripts/regen-system-health.py" ]; then
    python3 "$ATLAS_DIR/scripts/regen-system-health.py" >/dev/null 2>&1
fi

# Environment parity check (laptop vs VPS drift detection)
if [ -f "$ATLAS_DIR/scripts/check-env-parity.py" ]; then
    python3 "$ATLAS_DIR/scripts/check-env-parity.py" >/dev/null 2>&1
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
    # Codex 6282087 R3 F2 BLOCKING fix: gate HEAD_AFTER/diff/build/restart on
    # successful pull. Same shape as the NanoClaw block above.
    if sync_repo "$ATLAS_CMD_DIR" atlas-command; then
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
    else
        echo "$TIMESTAMP | SKIP | atlas-command | sync_repo non-zero; skipping rebuild + restart" >> "$LOG"
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
