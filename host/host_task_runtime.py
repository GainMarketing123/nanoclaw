#!/usr/bin/env python3
"""Host task runtime helpers for SEC-1 origin-auth gate."""

import json
import os
import tempfile
import time
from pathlib import Path

import host_task_auth


def load_hmac_key(etc_path=None) -> bytes:
    """Load host-task HMAC key bytes from credential file(s).

    Order:
      1) $CREDENTIALS_DIRECTORY/host-task-hmac   (systemd LoadCredential, production)
      2) /etc/atlas/host-task-hmac.secret        (direct; dev/root)

    `etc_path` overrides the second path; it exists solely so the unit test
    can stay hermetic (point it at a guaranteed-absent temp path) instead of
    reading the real /etc secret, which is present on the VPS host. Production
    callers pass nothing and get the real path. NEVER reads anything under
    ~/.atlas (container-readable). Returns b"" on any failure
    (missing/unreadable/bad-hex/too-short). Never raises.
    """

    paths = []
    cred_dir = os.environ.get("CREDENTIALS_DIRECTORY")
    if cred_dir:
        paths.append(Path(cred_dir) / "host-task-hmac")
    paths.append(Path(etc_path) if etc_path is not None
                 else Path("/etc/atlas/host-task-hmac.secret"))

    for path in paths:
        try:
            raw = path.read_text().strip()
            key = bytes.fromhex(raw)
            if len(key) >= 32:
                return key
        except Exception:
            pass
    return b""


class NonceCache:
    """Single-threaded nonce replay cache persisted as JSON.

    Storage shape: {"nonces": {nonce_str: expires_at_int}}
    """

    def __init__(self, path):
        self.path = Path(path)
        self.nonces = {}

        now = int(time.time())
        try:
            data = json.loads(self.path.read_text())
            loaded = data.get("nonces", {})
            if isinstance(loaded, dict):
                for nonce, expires_at in loaded.items():
                    if isinstance(nonce, str) and type(expires_at) is int and expires_at >= now:
                        self.nonces[nonce] = expires_at
        except Exception:
            self.nonces = {}

        self._persist_best_effort()

    def is_seen(self, nonce):
        now = int(time.time())
        expires_at = self.nonces.get(nonce)
        return type(expires_at) is int and expires_at >= now

    def record(self, nonce, expires_at):
        self.nonces[nonce] = int(expires_at)
        self._persist_best_effort()

    def _persist_best_effort(self):
        state = {"nonces": self.nonces}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        except Exception:
            pass

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=str(self.path.parent),
                delete=False,
            ) as tmp:
                tmp_path = Path(tmp.name)
                tmp.write(json.dumps(state))
            try:
                os.chmod(tmp_path, 0o600)
            except Exception:
                pass
            os.replace(str(tmp_path), str(self.path))
        except Exception:
            try:
                if tmp_path is not None and tmp_path.exists():
                    tmp_path.unlink()
            except Exception:
                pass


def gate_decision(task, key, now, nonce_cache, max_skew=60):
    ok, reason = host_task_auth.verify(task, key, now, max_skew)
    if not ok:
        return (False, reason)
    if nonce_cache.is_seen(task["nonce"]):
        return (False, "replayed")
    return (True, "ok")
