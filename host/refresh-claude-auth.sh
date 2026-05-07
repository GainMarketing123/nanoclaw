#!/bin/bash
# Refresh Claude Code credentials on VPS from laptop
#
# Phase 3.2 (1.A.6) cutover: credentials live under nanoclaw-he's home,
# not /home/atlas/. Script must run as root (chown target is nanoclaw-he).
#
# Usage (on VPS, as root):   /home/atlas/scripts/refresh-claude-auth.sh
# Usage (from laptop):       ssh root@5.78.190.56 /home/atlas/scripts/refresh-claude-auth.sh
#
# Prerequisites: SSH key access from VPS to laptop, or run scp from laptop first.
# Simplest: run this from your laptop:
#   scp ~/.claude/.credentials.json root@5.78.190.56:/home/nanoclaw-he/.claude/.credentials.json

set -euo pipefail

# CLAUDE_CONFIG_DIR is the Claude CLI / Anthropic SDK standard env var
# for relocating the credential root. VPS-specific default: this script
# ONLY runs on the VPS as root managing nanoclaw-he, so the fallback
# hardcodes nanoclaw-he's home rather than generic ${HOME}/.claude
# (which would resolve to /root/.claude when invoked via SSH-as-root,
# silently writing credentials to the wrong tree).
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-/home/nanoclaw-he/.claude}"
CREDS_FILE="$CLAUDE_HOME/.credentials.json"
BACKUP_FILE="$CLAUDE_HOME/.credentials.json.bak"

echo "=== Atlas Claude Auth Refresh ==="

# Backup existing credentials
if [ -f "$CREDS_FILE" ]; then
    cp "$CREDS_FILE" "$BACKUP_FILE"
    echo "Backed up existing credentials"
fi

# Check if credentials were provided via stdin (pipe mode)
if [ ! -t 0 ]; then
    echo "Reading credentials from stdin..."
    # Phase 3.2: ensure the .claude directory exists and is owned by nanoclaw-he
    install -d -m 0755 -o nanoclaw-he -g nanoclaw-he "$CLAUDE_HOME"

    # Codex 8ac9c6c F2 BLOCKING fix: write to a temp file in the same
    # directory then atomic-rename into place. The prior `cat > "$CREDS_FILE"`
    # truncated the live file in place — the running credential proxy
    # (nanoclaw service) reads/rewrites the same path concurrently and
    # could parse a half-written file or clobber the new credentials with
    # its own refresh-write. mv on the same filesystem is atomic at the
    # rename boundary, so the proxy sees either the old file or the new
    # file — never a mid-truncate state.
    TMP_CREDS=$(mktemp -p "$CLAUDE_HOME" .credentials.json.new.XXXXXX)
    trap 'rm -f "$TMP_CREDS"' EXIT
    cat > "$TMP_CREDS"
    # Validate the temp file is non-empty + parseable JSON before swapping in.
    if [ ! -s "$TMP_CREDS" ]; then
        echo "ERROR: stdin produced empty credentials file. Aborting."
        exit 1
    fi
    if ! python3 -c "import json,sys; json.load(open('$TMP_CREDS'))" 2>/dev/null; then
        echo "ERROR: stdin credentials are not valid JSON. Aborting."
        exit 1
    fi
    chmod 600 "$TMP_CREDS"
    chown nanoclaw-he:nanoclaw-he "$TMP_CREDS"
    mv -f "$TMP_CREDS" "$CREDS_FILE"
    trap - EXIT
    echo "Credentials written from stdin (atomic replace)"
else
    echo ""
    echo "No stdin detected. Copy credentials from your laptop:"
    echo ""
    echo "  scp ~/.claude/.credentials.json root@5.78.190.56:$CREDS_FILE"
    echo ""
    echo "Or pipe them:"
    echo ""
    echo "  ssh root@5.78.190.56 '/home/atlas/scripts/refresh-claude-auth.sh' < ~/.claude/.credentials.json"
    echo ""
    exit 1
fi

# Verify — Phase 3.2 (1.A.6): credentials live under nanoclaw-he, which has
# /usr/sbin/nologin so `su -` won't work. runuser handles nologin shells
# when given a specific command. HOME must be set so claude reads the right
# .credentials.json file.
# Codex e39da2b F2 SOFT fix: pass CLAUDE_CONFIG_DIR through to verify so
# we check the EXACT path we just wrote to, not whatever path claude auth
# resolves from $HOME/.claude alone. Without this, an override that
# relocated the credential root would write correctly but verify against
# the default home-based path, report not logged in, and restore the
# backup even though the new credentials were written correctly.
AUTH_STATUS=$(runuser -u nanoclaw-he -- env HOME=/home/nanoclaw-he CLAUDE_CONFIG_DIR="$CLAUDE_HOME" claude auth status 2>&1 || true)
if echo "$AUTH_STATUS" | grep -q '"loggedIn": true'; then
    echo "Auth verified: logged in"
    echo "$AUTH_STATUS" | grep -E 'loggedIn|subscriptionType'

    # Restart services that use Claude auth.
    #
    # Codex a5f9100 F2 BLOCKING fix: restart is scoped to `nanoclaw` only
    # until the 1.A.6 Phase 3.2 User=nanoclaw-he migration lands on
    # atlas-host-executor.service. atlas-host-executor still runs as
    # User=atlas and intentionally omits CLAUDE_CONFIG_DIR — it resolves
    # auth from /home/atlas/.claude, not /home/nanoclaw-he/.claude that
    # this script just wrote. Restarting it here would cycle a service
    # without giving it the new credentials, masking the auth-mismatch
    # behind a "successful refresh" report.
    #
    # When Phase 3.2 lands (atlas-host-executor migrated to
    # User=nanoclaw-he with Environment=CLAUDE_CONFIG_DIR=/home/nanoclaw-he/.claude),
    # add `atlas-host-executor` back to the restart list so the executor
    # picks up the new credentials in lockstep with nanoclaw.
    echo "Restarting nanoclaw (atlas-host-executor restart deferred until Phase 3.2 User= migration)..."
    systemctl restart nanoclaw 2>/dev/null || true
    echo "Done. nanoclaw restarted."
else
    echo "WARNING: Auth status check failed. Credentials may be invalid."
    echo "$AUTH_STATUS"

    # Restore backup if verification failed.
    # Codex b7e9788 F1 BLOCKING fix: this script runs as root, so the
    # earlier `cp "$CREDS_FILE" "$BACKUP_FILE"` created a root-owned
    # backup. A naive `cp "$BACKUP_FILE" "$CREDS_FILE"` here would leave
    # a root-owned 0600 file unreadable to the nanoclaw-he runtime user
    # — `claude auth status` and the post-restart services would fail
    # auth instead of recovering. install(1) sets ownership and mode
    # atomically as part of the copy so the rolled-back file is
    # immediately usable by nanoclaw-he.
    if [ -f "$BACKUP_FILE" ]; then
        install -m 600 -o nanoclaw-he -g nanoclaw-he "$BACKUP_FILE" "$CREDS_FILE"
        echo "Restored previous credentials from backup (nanoclaw-he-owned)"
    fi
    exit 1
fi
