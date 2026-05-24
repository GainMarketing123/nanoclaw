#!/usr/bin/env python3
"""Host task signature helpers (SEC-1 section 11 spec)."""

import hashlib
import hmac
import json
import re
from typing import Any, Dict, Optional, Tuple

SCHEMA_VERSION = "ht1"


def sha256_hex(x: str) -> str:
    return hashlib.sha256(x.encode("utf-8")).hexdigest()


def canonical_sig_input(task: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "cb": sha256_hex(task["callback_group"]),
        "ent": task["entity"],
        "exp": task["expires_at"],
        "grp": task["source_group"],
        "iat": task["issued_at"],
        "model": task["model"],
        "nonce": task["nonce"],
        "pdir": sha256_hex(task["project_dir"]),
        "ph": sha256_hex(task["prompt"]),
        "tid": task["task_id"],
        "tier": task["tier"],
        "v": task["schema_version"],
    }


def canonical_bytes(task: Dict[str, Any]) -> bytes:
    sig_input = canonical_sig_input(task)
    return json.dumps(
        sig_input,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def sign(task: Dict[str, Any], key: bytes) -> str:
    return hmac.new(key, canonical_bytes(task), hashlib.sha256).hexdigest()


def _is_hex_string(value: Any) -> bool:
    # Strict: hex digits only, mirroring the TS regex /^[0-9a-fA-F]+$/.
    # int(value, 16) was too permissive (accepts "+ab", "-ab", surrounding
    # whitespace), which made Python and TS disagree on the missing_sig vs
    # bad_sig boundary (cross-review F4).
    return isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]+", value) is not None


# Fields canonical_sig_input() reads. If any is missing, or a hashed string
# field is non-str, sign() raises (KeyError / .encode on a non-str). verify()
# must fail closed with a reason, never propagate an exception on hostile
# queue input (cross-review F1).
_REQUIRED_STR_FIELDS = (
    "task_id", "source_group", "entity", "model",
    "project_dir", "prompt", "callback_group", "nonce",
)
_REQUIRED_INT_FIELDS = ("tier", "issued_at", "expires_at")


def _validate_shape(task: Dict[str, Any]) -> Optional[str]:
    """Return a failure reason if the task lacks fields sign()/verify() need."""
    for field in _REQUIRED_STR_FIELDS:
        if not isinstance(task.get(field), str):
            return "bad_task"
    for field in _REQUIRED_INT_FIELDS:
        # Require an actual int (type is int, which excludes bool), not merely
        # present. None/str/float would pass a presence check; Python's
        # json.dumps tolerates them (so sign() would not raise) but the reason
        # code would diverge from TS, which returns bad_task. Keep the two
        # implementations in lockstep (cross-review round 2).
        if type(task.get(field)) is not int:
            return "bad_task"
    return None


def verify(
    task: Dict[str, Any],
    key: bytes,
    now: int,
    max_skew: int = 60,
) -> Tuple[bool, str]:
    if task.get("schema_version") != SCHEMA_VERSION:
        return (False, "bad_schema")

    sig = task.get("_sig")
    if not _is_hex_string(sig):
        return (False, "missing_sig")

    # Validate shape BEFORE signing so a malformed/hostile task fails closed
    # with a reason instead of raising inside canonical_sig_input()/sign()
    # (cross-review F1).
    shape_reason = _validate_shape(task)
    if shape_reason is not None:
        return (False, shape_reason)

    computed = sign(task, key)
    # Case-insensitive hex compare (lowercase both) so an upper/mixed-case
    # _sig matches the same way the TS verifier (byte decode) treats it
    # (cross-review F3). compare_digest stays constant-time over the hex text.
    if not hmac.compare_digest(computed, sig.lower()):
        return (False, "bad_sig")

    if (
        type(task.get("tier")) is not int
        or type(task.get("issued_at")) is not int
        or type(task.get("expires_at")) is not int
    ):
        return (False, "bad_types")

    if now > task["expires_at"]:
        return (False, "expired")

    if task["issued_at"] > now + max_skew:
        return (False, "future")

    return (True, "ok")
