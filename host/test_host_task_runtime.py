#!/usr/bin/env python3

import os
import sys
import tempfile
from pathlib import Path

import host_task_auth
import host_task_runtime


def fail(msg):
    print("FAIL:", msg)
    raise SystemExit(1)


def assert_eq(actual, expected, msg):
    if actual != expected:
        fail(f"{msg}: expected {expected!r}, got {actual!r}")


def build_task(key):
    task = {
        "schema_version": "ht1",
        "task_id": "t-123",
        "source_group": "atlas_main",
        "entity": "atlas",
        "model": "claude-3-5-sonnet-latest",
        "project_dir": "/tmp/project",
        "prompt": "Do work",
        "callback_group": "atlas_main",
        "nonce": "abc123nonce",
        "tier": 2,
        "issued_at": 2000000000,
        "expires_at": 2000000300,
    }
    task["_sig"] = host_task_auth.sign(task, key)
    return task


def main():
    key = bytes.fromhex("11" * 32)

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        cache_path = td_path / "nonce-cache.json"
        cache = host_task_runtime.NonceCache(cache_path)

        task = build_task(key)

        # valid + fresh
        got = host_task_runtime.gate_decision(task, key, 2000000100, cache)
        assert_eq(got, (True, "ok"), "valid task should pass")

        # missing sig
        missing_sig = dict(task)
        missing_sig.pop("_sig", None)
        got = host_task_runtime.gate_decision(missing_sig, key, 2000000100, cache)
        assert_eq(got, (False, "missing_sig"), "missing _sig should reject")

        # bad sig by tamper
        bad_sig = dict(task)
        bad_sig["project_dir"] = "/tmp/other"
        got = host_task_runtime.gate_decision(bad_sig, key, 2000000100, cache)
        assert_eq(got, (False, "bad_sig"), "tampered task should reject bad_sig")

        # bad_task by wrong tier type
        bad_task = dict(task)
        bad_task["tier"] = "2"
        bad_task["_sig"] = host_task_auth.sign(task, key)
        got = host_task_runtime.gate_decision(bad_task, key, 2000000100, cache)
        assert_eq(got, (False, "bad_task"), "tier string should reject bad_task")

        # expired
        got = host_task_runtime.gate_decision(task, key, 2000000301, cache)
        assert_eq(got, (False, "expired"), "expired task should reject")

        # replay
        if cache.is_seen(task["nonce"]):
            fail("nonce unexpectedly seen before record")
        cache.record(task["nonce"], task["expires_at"])
        got = host_task_runtime.gate_decision(task, key, 2000000100, cache)
        assert_eq(got, (False, "replayed"), "recorded nonce should reject as replayed")

        # NonceCache persistence + prune across reload
        mixed_cache_path = td_path / "mixed-nonces.json"
        mixed_cache_path.write_text(
            '{"nonces": {"expired_nonce": 100, "live_nonce": 9999999999}}',
            encoding="utf-8",
        )
        mixed_cache = host_task_runtime.NonceCache(mixed_cache_path)
        if "expired_nonce" in mixed_cache.nonces:
            fail("expired nonce was not pruned")
        if "live_nonce" not in mixed_cache.nonces:
            fail("live nonce missing after load")
        if mixed_cache.is_seen("expired_nonce"):
            fail("expired nonce unexpectedly seen")
        if not mixed_cache.is_seen("live_nonce"):
            fail("live nonce should be seen")

        reloaded = host_task_runtime.NonceCache(mixed_cache_path)
        if "expired_nonce" in reloaded.nonces:
            fail("expired nonce reappeared after reload")
        if "live_nonce" not in reloaded.nonces:
            fail("live nonce missing after reload")

        # load_hmac_key from CREDENTIALS_DIRECTORY
        old_cred_dir = os.environ.get("CREDENTIALS_DIRECTORY")
        try:
            cred_dir = td_path / "creds"
            cred_dir.mkdir(parents=True, exist_ok=True)
            key_file = cred_dir / "host-task-hmac"
            # Guaranteed-absent /etc override keeps these cases hermetic: the
            # loader must NOT fall through to the real /etc secret (present on
            # the VPS host), which would break malformed/absent assertions there.
            no_etc = td_path / "no-such-etc-secret"

            key_file.write_text("ab" * 32, encoding="utf-8")
            os.environ["CREDENTIALS_DIRECTORY"] = str(cred_dir)
            loaded = host_task_runtime.load_hmac_key(etc_path=no_etc)
            assert_eq(loaded, bytes.fromhex("ab" * 32), "valid credential hex key load")

            key_file.write_text("not-hex", encoding="utf-8")
            loaded = host_task_runtime.load_hmac_key(etc_path=no_etc)
            assert_eq(loaded, b"", "malformed hex should return empty key")

            key_file.unlink()
            loaded = host_task_runtime.load_hmac_key(etc_path=no_etc)
            assert_eq(loaded, b"", "absent key should return empty")
        finally:
            if old_cred_dir is None:
                os.environ.pop("CREDENTIALS_DIRECTORY", None)
            else:
                os.environ["CREDENTIALS_DIRECTORY"] = old_cred_dir

    print("OK")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"unexpected exception: {exc}")
