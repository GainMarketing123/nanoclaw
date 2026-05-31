#!/usr/bin/env bash
#
# nanoclaw deploy ritual — run ON THE VPS after pulling new code.
#
# Why this exists: nanoclaw runs as a root systemd service with an ExecStartPre
# integrity gate that sha256-checks the dist artifacts against a recorded
# baseline and FAILS CLOSED on any mismatch. A build changes those hashes, so
# the baseline MUST be regenerated before restart — skip it and the service
# loops on startup (this caused a production outage on 2026-05-31). This script
# enforces the order: pull -> build -> regenerate baseline -> restart, and makes
# the restart the only step that needs root.
#
# Usage (on the VPS):  cd /home/atlas/nanoclaw && ./deploy/deploy.sh
#
set -euo pipefail

REPO="/home/atlas/nanoclaw"
SEC="/home/atlas/.atlas-operations/security"
POLICY="$SEC/config-integrity-policy.json"
BASELINE="$SEC/config-hashes.json"

cd "$REPO"

echo "==> 1/4  Pull latest (fast-forward only)"
# ff-only: refuse to deploy a diverged tree. If this fails, something pushed
# from the wrong place — investigate, do not force.
git pull --ff-only origin main
HEAD_SHA="$(git rev-parse --short HEAD)"
echo "    now at $HEAD_SHA"

echo "==> 2/4  Build"
npm run build

echo "==> 3/4  Regenerate config-integrity baseline"
# Recompute the sha256 of every file the policy tracks and write the baseline.
# No root needed — the baseline is owned by 'atlas'. Backup first for rollback.
BAK="$BASELINE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$BASELINE" "$BAK"
echo "    backed up baseline -> $BAK"
POLICY="$POLICY" BASELINE="$BASELINE" HEAD_SHA="$HEAD_SHA" python3 - <<'PY'
import json, hashlib, os, datetime
policy = json.load(open(os.environ["POLICY"]))["files"]
out = {
    "generated": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "files": {
        f: hashlib.sha256(open(f, "rb").read()).hexdigest() for f in policy
    },
    "regenerated_at": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "regenerated_reason": f"deploy.sh after build {os.environ['HEAD_SHA']}",
}
with open(os.environ["BASELINE"], "w") as fh:
    json.dump(out, fh, indent=2)
    fh.write("\n")
print(f"    baseline regenerated for {len(policy)} files")
PY

echo "==> 3.5  Verify the integrity gate passes BEFORE we bounce the service"
# Dry-run the exact pre-start check. If it fails now, the restart would loop —
# so stop here with the OLD service still running, rather than take it down.
if ! ATLAS_OPS_DIR=/home/atlas/.atlas-operations bash "$SEC/check-config-integrity.sh"; then
    echo "!!  Integrity gate FAILED after regen — NOT restarting. Old service still up." >&2
    echo "!!  Restore baseline with: cp -p '$BAK' '$BASELINE'" >&2
    exit 1
fi

echo "==> 4/4  Restart service (needs root)"
echo "    Running: sudo systemctl restart nanoclaw.service"
sudo systemctl restart nanoclaw.service
sleep 3
STATE="$(systemctl is-active nanoclaw.service || true)"
echo "    service is now: $STATE"
[ "$STATE" = "active" ] || { echo "!!  service not active — check 'journalctl -u nanoclaw.service'" >&2; exit 1; }
echo "==> Deploy complete: $HEAD_SHA live."
