#!/bin/bash
# RETIRED 2026-05-24 (session 3969d6a0): this copy of git-sync.sh has been
# consolidated into the single canonical sync script to end the 3-copy drift
# that left the production lib tree stale for ~2 weeks.
#
# CANONICAL: atlas-engineering scripts/git-sync.sh, deployed to the VPS at
# /home/atlas/git-sync.sh by atlas-engineering scripts/deploy_git_sync.py, and
# scheduled there (3am daily + on /done). That script is queue-based for restarts
# and now carries the seal-aware atlas-lib mirror (via the root-owned wrapper
# /usr/local/libexec/atlas/mirror-lib.sh).
#
# This file is NOT scheduled and is NOT sourced by any test (it never had the
# BASH_SOURCE library guard the canonical script uses). It remains only as a
# breadcrumb at the historical path. Do NOT add sync logic here — edit the
# canonical script instead.
# Context: ~/.atlas/plans/host-executor-lib-security-finding-2026-05-23.md §1, §10.
echo "git-sync.sh here is RETIRED — canonical is atlas-engineering scripts/git-sync.sh (deployed to /home/atlas/git-sync.sh). This copy does nothing." >&2
exit 0
