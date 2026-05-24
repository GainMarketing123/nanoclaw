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

    # cross-review F1: a malformed task fails closed with a reason, never raises.
    missing_field = copy.deepcopy(task)
    missing_field.pop("project_dir", None)
    ok, reason = verify(missing_field, key, now=task["issued_at"])
    assert (ok, reason) == (False, "bad_task")

    non_str_field = copy.deepcopy(task)
    non_str_field["prompt"] = 123
    ok, reason = verify(non_str_field, key, now=task["issued_at"])
    assert (ok, reason) == (False, "bad_task")

    # cross-review F3: an upper/mixed-case hex signature still verifies.
    upper_sig = copy.deepcopy(task)
    upper_sig["_sig"] = upper_sig["_sig"].upper()
    ok, reason = verify(upper_sig, key, now=task["issued_at"])
    assert (ok, reason) == (True, "ok")

    # cross-review F4: a non-hex _sig is missing_sig (strict), not bad_sig.
    bad_hex_sig = copy.deepcopy(task)
    bad_hex_sig["_sig"] = "+" + task["_sig"][1:]
    ok, reason = verify(bad_hex_sig, key, now=task["issued_at"])
    assert (ok, reason) == (False, "missing_sig")

    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
