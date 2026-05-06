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

CREDS_FILE="/home/nanoclaw-he/.claude/.credentials.json"
BACKUP_FILE="/home/nanoclaw-he/.claude/.credentials.json.bak"

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
    install -d -m 0755 -o nanoclaw-he -g nanoclaw-he /home/nanoclaw-he/.claude
    cat > "$CREDS_FILE"
    chmod 600 "$CREDS_FILE"
    chown nanoclaw-he:nanoclaw-he "$CREDS_FILE"
    echo "Credentials written from stdin"
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
AUTH_STATUS=$(runuser -u nanoclaw-he -- env HOME=/home/nanoclaw-he claude auth status 2>&1 || true)
if echo "$AUTH_STATUS" | grep -q '"loggedIn": true'; then
    echo "Auth verified: logged in"
    echo "$AUTH_STATUS" | grep -E 'loggedIn|subscriptionType'

    # Restart services that use Claude auth
    echo "Restarting nanoclaw and host-executor..."
    systemctl restart nanoclaw atlas-host-executor 2>/dev/null || true
    echo "Done. All services restarted."
else
    echo "WARNING: Auth status check failed. Credentials may be invalid."
    echo "$AUTH_STATUS"

    # Restore backup if verification failed
    if [ -f "$BACKUP_FILE" ]; then
        cp "$BACKUP_FILE" "$CREDS_FILE"
        echo "Restored previous credentials from backup"
    fi
    exit 1
fi
