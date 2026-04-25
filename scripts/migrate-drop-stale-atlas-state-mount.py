#!/usr/bin/env python3
"""
Drop stale atlas-state additionalMounts from registered_groups configs.

Background:
  Before mount collision validation landed in src/mount-security.ts,
  scripts/create-group.sh could write an additionalMount with
  containerPath='atlas-state' pointing at ATLAS_DIR (~/.atlas). That mount
  shadowed the orchestrator's per-group writable governance directory at
  /workspace/extra/atlas-state and gave every group write access to the
  control plane. The be97e23 redesign moved governance state into a
  per-group writable directory and remounted ~/.atlas read-only at
  /home/node/.atlas.

Scope:
  This one-shot migration scans registered_groups.container_config and removes
  only additionalMounts whose containerPath collides with the reserved Atlas
  internal paths:
    - atlas-state
    - atlas-state/host-tasks
  All other mounts and config fields are left untouched. The migration is
  idempotent.

What This Does Not Do:
  - Repopulate govStateDir from ATLAS_DIR.
  - Update agent-runner paths that still read control-plane files from
    /workspace/extra/atlas-state.

Usage:
  ./scripts/migrate-drop-stale-atlas-state-mount.py [--db PATH] [--dry-run]

Default DB path:
  <project_root>/store/messages.db
"""

import argparse
import json
import posixpath
import sqlite3
import sys
from pathlib import Path


RESERVED_CONTAINER_PATHS = [
    "atlas-state",
    "atlas-state/host-tasks",
]


def find_project_root() -> Path:
    """Walk up from this script until the NanoClaw project root is found."""
    script_path = Path(__file__).resolve()
    for parent in script_path.parents:
        if (parent / "src").is_dir() and (parent / "scripts").is_dir():
            return parent
    return script_path.parent.parent


def default_db_path() -> Path:
    """Return the default SQLite DB path used by NanoClaw."""
    return find_project_root() / "store" / "messages.db"


def normalize_container_path(path_value: str) -> str:
    """
    Normalize a container-relative POSIX path for collision comparison.

    Mirrors src/mount-security.ts semantics with one defensive difference:
    '..' segments are preserved rather than resolved.
    """
    if not path_value:
        return ""

    parts = []
    for part in path_value.split(posixpath.sep):
        if part == "" or part == ".":
            continue
        parts.append(part)

    normalized = posixpath.sep.join(parts)
    if normalized == "":
        return "."
    if normalized != posixpath.sep and normalized.endswith(posixpath.sep):
        return normalized[:-1]
    return normalized


def collides_with_reserved_path(user_path: str) -> bool:
    """Return True when a user mount path overlaps a reserved Atlas path."""
    if not user_path:
        return False

    normalized = normalize_container_path(user_path)
    if normalized == ".":
        return True

    for reserved in RESERVED_CONTAINER_PATHS:
        norm_reserved = normalize_container_path(reserved)
        if normalized == norm_reserved:
            return True
        if normalized.startswith(norm_reserved + "/"):
            return True
        if norm_reserved.startswith(normalized + "/"):
            return True

    return False


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default=str(default_db_path()),
        help="Path to the NanoClaw SQLite DB (default: %(default)s)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print intended updates without writing changes",
    )
    return parser.parse_args()


def load_group_rows(conn: sqlite3.Connection):
    """Yield registered group rows in a stable order."""
    return conn.execute(
        """
        SELECT jid, name, container_config
        FROM registered_groups
        ORDER BY added_at, jid
        """
    )


def main() -> int:
    """Run the migration."""
    args = parse_args()
    db_path = Path(args.db)

    if not db_path.exists():
        print(f"Warning: database not found: {db_path}", file=sys.stderr)
        return 0

    conn = sqlite3.connect(db_path)
    updated_groups = 0

    try:
        for jid, name, container_config in load_group_rows(conn):
            if not container_config:
                continue

            try:
                config = json.loads(container_config)
            except json.JSONDecodeError as exc:
                print(f"  [skip] {jid} ({name}): invalid JSON: {exc}", file=sys.stderr)
                continue

            if not isinstance(config, dict):
                continue

            mounts = config.get("additionalMounts")
            if not isinstance(mounts, list):
                continue

            kept_mounts = []
            dropped_mounts = []

            for mount in mounts:
                if isinstance(mount, dict) and isinstance(mount.get("containerPath"), str):
                    if collides_with_reserved_path(mount["containerPath"]):
                        dropped_mounts.append(mount)
                        continue
                kept_mounts.append(mount)

            if not dropped_mounts:
                continue

            action = "would update" if args.dry_run else "updating"
            print(f"  [{action}] {jid} ({name}): dropping {len(dropped_mounts)} stale mount(s)")
            for mount in dropped_mounts:
                print(
                    "      -> "
                    f"hostPath={mount.get('hostPath')!r} "
                    f"containerPath={mount.get('containerPath')!r}"
                )

            updated_groups += 1

            if args.dry_run:
                continue

            config["additionalMounts"] = kept_mounts
            conn.execute(
                "UPDATE registered_groups SET container_config = ? WHERE jid = ?",
                (json.dumps(config), jid),
            )

        if not args.dry_run:
            conn.commit()
    finally:
        conn.close()

    if args.dry_run:
        print(f"Done. {updated_groups} group(s) would be updated.")
    else:
        print(f"Done. {updated_groups} group(s) updated.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
