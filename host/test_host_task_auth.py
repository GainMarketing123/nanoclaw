#!/usr/bin/env python3

import copy
import json
from pathlib import Path

from host_task_auth import canonical_bytes, sign, verify


def main() -> int:
    fixture_path = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "host-task-sig-vector.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    key = bytes.fromhex(fixture["key_hex"])
    task = fixture["task"]

    actual_canonical = canonical_bytes(task).decode("utf-8")
    assert actual_canonical == fixture["expected_canonical"]

    actual_sig = sign(task, key)
    assert actual_sig == fixture["expected_sig"]

    ok, reason = verify(task, key, now=task["issued_at"])
    assert (ok, reason) == (True, "ok")

    tampered_project_dir = copy.deepcopy(task)
    tampered_project_dir["project_dir"] = "/srv/projects/other"
    ok, reason = verify(tampered_project_dir, key, now=tampered_project_dir["issued_at"])
    assert (ok, reason) == (False, "bad_sig")

    tampered_tier = copy.deepcopy(task)
    tampered_tier["tier"] = 3
    ok, reason = verify(tampered_tier, key, now=tampered_tier["issued_at"])
    assert (ok, reason) == (False, "bad_sig")

    ok, reason = verify(task, key, now=task["expires_at"] + 1)
    assert (ok, reason) == (False, "expired")

    missing_sig = copy.deepcopy(task)
    missing_sig.pop("_sig", None)
    ok, reason = verify(missing_sig, key, now=missing_sig["issued_at"])
    assert (ok, reason) == (False, "missing_sig")

    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
