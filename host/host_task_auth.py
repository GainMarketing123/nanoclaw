#!/usr/bin/env python3
"""Host task signature helpers (SEC-1 section 11 spec)."""

import hashlib
import hmac
import json
from typing import Any, Dict, Tuple

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
    if not isinstance(value, str) or value == "":
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


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

    computed = sign(task, key)
    if not hmac.compare_digest(computed, sig):
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
