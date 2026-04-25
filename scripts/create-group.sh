#!/bin/bash
set -euo pipefail

# ============================================================================
# Atlas Group Onboarding — Automated group creation with shared workspace
#
# Usage:
#   create-group.sh \
#     --name "GPG Property Managers" \
#     --folder atlas_gpg_propmanagers \
#     --department operations \
#     --entity gpg \
#     --trigger "@Atlas" \
#     --jid "tg:XXXXXXX" \
#     [--requires-trigger true|false] \
#     [--context-transfer]   # Run LLM-powered context extraction
#
# What it does:
#   1. Composes CLAUDE.md from templates (group-base + department + entity + restrictions)
#   2. Creates shared workspace directories
#   3. Registers group in NanoClaw SQLite with correct mounts
#   4. Updates mount allowlist if needed
#   5. Optionally runs context transfer (LLM extraction from atlas_main memory)
#   6. Restarts NanoClaw
# ============================================================================

NANOCLAW_DIR="${NANOCLAW_DIR:-/home/atlas/nanoclaw}"
ATLAS_DIR="${ATLAS_DIR:-/home/atlas/.atlas}"
TEMPLATES_DIR="${NANOCLAW_DIR}/templates/group-claude-md"
SHARED_DIR="${ATLAS_DIR}/shared"
DB_PATH="${NANOCLAW_DIR}/store/messages.db"

# --- Parse arguments ---
NAME=""
FOLDER=""
DEPARTMENT=""
ENTITY=""
TRIGGER="@Atlas"
JID=""
REQUIRES_TRIGGER="true"
CONTEXT_TRANSFER=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) NAME="$2"; shift 2 ;;
    --folder) FOLDER="$2"; shift 2 ;;
    --department) DEPARTMENT="$2"; shift 2 ;;
    --entity) ENTITY="$2"; shift 2 ;;
    --trigger) TRIGGER="$2"; shift 2 ;;
    --jid) JID="$2"; shift 2 ;;
    --requires-trigger) REQUIRES_TRIGGER="$2"; shift 2 ;;
    --context-transfer) CONTEXT_TRANSFER=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Validate ---
# Reject --context-transfer up front so that a flag whose feature is currently
# disabled never produces partially-applied onboarding state. See the long
# comment block at Step 6 below for the architectural backstory and the
# documented re-enable paths.
if $CONTEXT_TRANSFER; then
  echo "Error: --context-transfer is currently DISABLED pending architectural redesign." >&2
  echo "  See scripts/create-group.sh Step 6 comment block for re-enable options" >&2
  echo "  (container-runner route, host-side Python script, or .gitignore allowlist +" >&2
  echo "  in-worktree commit). Re-run without --context-transfer to onboard the group" >&2
  echo "  cleanly without context transfer." >&2
  exit 2
fi

if [[ -z "$NAME" || -z "$FOLDER" || -z "$DEPARTMENT" || -z "$ENTITY" || -z "$JID" ]]; then
  echo "Error: --name, --folder, --department, --entity, and --jid are required"
  echo ""
  echo "Usage:"
  echo "  create-group.sh \\"
  echo "    --name \"GPG Marketing\" \\"
  echo "    --folder telegram_atlas-marketing \\"
  echo "    --department marketing \\"
  echo "    --entity gpg \\"
  echo "    --trigger \"@Atlas\" \\"
  echo "    --jid \"tg:-5063551496\""
  exit 1
fi

# Validate department template exists
if [[ ! -f "${TEMPLATES_DIR}/departments/${DEPARTMENT}.md" ]]; then
  echo "Error: No department template at ${TEMPLATES_DIR}/departments/${DEPARTMENT}.md"
  echo "Available departments:"
  ls "${TEMPLATES_DIR}/departments/" 2>/dev/null | sed 's/\.md$//'
  exit 1
fi

# Validate entity template exists
if [[ ! -f "${TEMPLATES_DIR}/entities/${ENTITY}.md" ]]; then
  echo "Error: No entity template at ${TEMPLATES_DIR}/entities/${ENTITY}.md"
  echo "Available entities:"
  ls "${TEMPLATES_DIR}/entities/" 2>/dev/null | sed 's/\.md$//'
  exit 1
fi

# Entity display name mapping
declare -A ENTITY_DISPLAY=(
  [gpg]="Gain Property Group"
  [crownscape]="Crownscape"
)
ENTITY_DISP="${ENTITY_DISPLAY[$ENTITY]:-$ENTITY}"

echo "=== Atlas Group Onboarding ==="
echo "  Name:       $NAME"
echo "  Folder:     $FOLDER"
echo "  Department: $DEPARTMENT"
echo "  Entity:     $ENTITY_DISP"
echo "  Trigger:    $TRIGGER"
echo "  JID:        $JID"
echo ""

# --- Step 1: Compose CLAUDE.md from templates ---
echo "Step 1: Composing CLAUDE.md..."

GROUP_DIR="${NANOCLAW_DIR}/groups/${FOLDER}"
mkdir -p "${GROUP_DIR}/logs"

TODAY=$(date +%Y-%m-%d)

# Read templates and substitute variables
compose_template() {
  local file="$1"
  cat "$file" | \
    sed "s|{{GROUP_NAME}}|${NAME}|g" | \
    sed "s|{{DEPARTMENT}}|${DEPARTMENT}|g" | \
    sed "s|{{ENTITY_DISPLAY}}|${ENTITY_DISP}|g" | \
    sed "s|{{ENTITY}}|${ENTITY}|g" | \
    sed "s|{{DATE}}|${TODAY}|g" | \
    sed 's|{{slug}}|description|g'
}

{
  compose_template "${TEMPLATES_DIR}/group-base.md"
  echo ""
  echo "---"
  echo ""
  cat "${TEMPLATES_DIR}/departments/${DEPARTMENT}.md"
  echo ""
  echo "---"
  echo ""
  cat "${TEMPLATES_DIR}/entities/${ENTITY}.md"
  echo ""
  echo "---"
  echo ""
  cat "${TEMPLATES_DIR}/restrictions.md"
} > "${GROUP_DIR}/CLAUDE.md"

echo "  Created: ${GROUP_DIR}/CLAUDE.md"

# --- Step 2: Create shared workspace directories ---
echo "Step 2: Creating shared workspace..."

DEPT_SHARED="${SHARED_DIR}/${DEPARTMENT}"
for subdir in directives updates briefs escalations; do
  mkdir -p "${DEPT_SHARED}/${subdir}"
done

# Create empty context.md if it doesn't exist
if [[ ! -f "${DEPT_SHARED}/context.md" ]]; then
  cat > "${DEPT_SHARED}/context.md" << CTXEOF
# ${DEPARTMENT^} Department — Context Summary

_Auto-generated by Atlas orchestrator. Updated daily._

## Active Directives
(none yet)

## Recent Activity
(none yet)

## Key Decisions
(none yet)
CTXEOF
fi

# Ensure executive workspace always exists (CEO-only)
mkdir -p "${SHARED_DIR}/executive"

echo "  Created: ${DEPT_SHARED}/"

# --- Step 3: Register in NanoClaw SQLite ---
echo "Step 3: Registering group in database..."

REQ_TRIGGER=1
if [[ "$REQUIRES_TRIGGER" == "false" ]]; then
  REQ_TRIGGER=0
fi

# Build container config JSON with proper mounts
# Staff groups: department directives/briefs RO, updates/escalations RW
#
# NOTE: The 'atlas-state' container path is reserved for the orchestrator's
# per-group writable governance directory (see container-runner.ts — govStateDir
# at /workspace/extra/atlas-state) and the read-only ~/.atlas surface mounted at
# /home/node/.atlas. Adding an additionalMount with containerPath 'atlas-state'
# (or any path that overlaps it) is rejected by mount-security.ts and would
# silently drop at runtime. This script intentionally does NOT generate that
# mount anymore — the be97e23 migration moved governance state into a per-group
# isolated directory specifically to keep groups from sharing write access to
# the control plane.
python3 -c "
import sqlite3, json, sys

db = sqlite3.connect('${DB_PATH}')

# Build container config with shared workspace mounts
config = {
    'additionalMounts': [
        {
            'hostPath': '${DEPT_SHARED}',
            'containerPath': 'shared/${DEPARTMENT}',
            'readonly': False
        }
    ]
}

config_json = json.dumps(config)

# Check if group already exists
existing = db.execute('SELECT jid FROM registered_groups WHERE jid = ?', ('${JID}',)).fetchone()

if existing:
    db.execute('''UPDATE registered_groups
                  SET name = ?, folder = ?, trigger_pattern = ?,
                      container_config = ?, requires_trigger = ?
                  WHERE jid = ?''',
               ('${NAME}', '${FOLDER}', '${TRIGGER}', config_json, ${REQ_TRIGGER}, '${JID}'))
    print('  Updated existing group: ${JID}')
else:
    db.execute('''INSERT INTO registered_groups
                  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
                  VALUES (?, ?, ?, ?, datetime('now'), ?, ?, 0)''',
               ('${JID}', '${NAME}', '${FOLDER}', '${TRIGGER}', config_json, ${REQ_TRIGGER}))
    print('  Registered new group: ${JID}')

db.commit()

# Verify
row = db.execute('SELECT container_config FROM registered_groups WHERE jid = ?', ('${JID}',)).fetchone()
json.loads(row[0])  # Validate JSON
print('  Config verified: valid JSON')
db.close()
"

# --- Step 4: Update atlas_main mounts to include this shared workspace ---
echo "Step 4: Ensuring atlas_main has shared workspace access..."

python3 -c "
import sqlite3, json

db = sqlite3.connect('${DB_PATH}')
row = db.execute('SELECT container_config FROM registered_groups WHERE is_main = 1').fetchone()
if not row or not row[0]:
    print('  Warning: atlas_main has no container config')
    db.close()
    exit(0)

config = json.loads(row[0])
mounts = config.get('additionalMounts', [])

# Check if shared workspace mount already exists
shared_mount_path = '${SHARED_DIR}'
has_shared = any(m.get('containerPath') == 'shared' for m in mounts)

if not has_shared:
    mounts.append({
        'hostPath': shared_mount_path,
        'containerPath': 'shared',
        'readonly': False
    })
    config['additionalMounts'] = mounts
    db.execute('UPDATE registered_groups SET container_config = ? WHERE is_main = 1',
               (json.dumps(config),))
    db.commit()
    print('  Added shared workspace mount to atlas_main')
else:
    print('  atlas_main already has shared workspace mount')

db.close()
"

# --- Step 5: Clear stale sessions ---
echo "Step 5: Clearing stale sessions..."
sqlite3 "${DB_PATH}" "DELETE FROM sessions WHERE group_folder = '${FOLDER}';"
echo "  Cleared sessions for ${FOLDER}"

# --- Step 6: Context transfer (DISABLED — architectural redesign required) ---
#
# The --context-transfer flag is intentionally a no-op as of 2026-04-25.
#
# Background: the original prompt was written assuming container execution
# (mounts at /workspace/extra/, /home/node/.atlas, etc.), but the task is
# dispatched to host-executor.py which runs `claude -p` on the VPS HOST with
# cwd=project_dir. Multiple architectural mismatches surfaced in cross-model
# review and prevent a clean fix without re-architecting either the prompt
# delivery channel or the output surfacing mechanism:
#   1. Container paths do not exist on the host (/home/node/..., /workspace/...).
#   2. Tier-1 read-only tools cannot satisfy a prompt that requires writes.
#   3. The repo's .gitignore excludes groups/<folder>/* (everything except a
#      tiny CLAUDE.md allowlist), so any in-repo output cannot be committed
#      and surfaced via host-executor's auto-push pipeline.
#   4. host-executor's merge_worktree_branches() only merges COMMITTED files,
#      so outputs that aren't explicitly committed inside the worktree are
#      lost when the worktree is pruned.
#
# To re-enable, choose one of:
#   (A) Route context-transfer through the container runner so the original
#       container-mount paths resolve, and write outputs to
#       /workspace/extra/shared/${DEPARTMENT}/ which is a real bind mount.
#   (B) Replace the claude-driven prompt with a pure host-side Python script
#       that reads ~/.atlas/memory/ and writes ~/.atlas/shared/${DEPARTMENT}/
#       directly. No subprocess, no worktree, no merge.
#   (C) Add an explicit instruction to commit outputs inside the worktree,
#       allowlist groups/${FOLDER}/context-transfer/ in .gitignore, and have
#       the operator pull from main after the auto-push completes. This is
#       the most invasive option.
#
# Tracked as a follow-up roadmap item.
# NOTE: $CONTEXT_TRANSFER is always false here because --context-transfer is
# rejected up front in the validation block at the top of the script.
echo "Step 6: Context transfer skipped (--context-transfer is currently disabled — see comment block above)"

# --- Step 7: Restart NanoClaw ---
echo "Step 7: Restarting NanoClaw..."
systemctl restart nanoclaw 2>/dev/null || echo "  Warning: could not restart nanoclaw (run as root or use sudo)"

echo ""
echo "=== Group onboarding complete ==="
echo "  CLAUDE.md: ${GROUP_DIR}/CLAUDE.md"
echo "  Shared:    ${DEPT_SHARED}/"
echo "  Database:  registered"
echo ""
echo "Test: send a message in the group mentioning ${TRIGGER}"
