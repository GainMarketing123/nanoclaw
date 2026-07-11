#!/usr/bin/env python3
"""Unit tests for the Haiku quality-check OAuth cutover (2026-07-11).

Covers _load_oauth_token (source order + failure modes), _haiku_request_once
(OAuth header/token build, tri-state mapping, error classification), and
_call_haiku's re-read-on-401 retry. Transport (urllib.request.urlopen) is
mocked — no network. Run: python3 test_call_haiku_oauth.py
"""

import importlib.util
import io
import json
import os
import sys
import tempfile
import urllib.error
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

# host-executor.py has a hyphen, so import it by file path.
_spec = importlib.util.spec_from_file_location("host_executor_mod", _HERE / "host-executor.py")
he = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(he)

_FAILS = []


def check(cond, msg):
    if cond:
        print("  ok:", msg)
    else:
        print("  FAIL:", msg)
        _FAILS.append(msg)


# ---------------------------------------------------------------------------
# Transport mocks
# ---------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _grade_payload(score, violations=None):
    inner = json.dumps({"score": score, "violations": violations or []})
    return json.dumps({"content": [{"type": "text", "text": inner}]}).encode("utf-8")


def _http_error(code, body):
    return urllib.error.HTTPError(
        "https://api.anthropic.com/v1/messages", code, "err", None,
        io.BytesIO(body.encode("utf-8")),
    )


class _Transport:
    """Scripted urlopen replacement. `script` is a list of callables that each
    take the request and return a _FakeResp or raise. Records every request."""

    def __init__(self, script):
        self.script = list(script)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        action = self.script.pop(0)
        return action(req)


def _with_transport(script):
    t = _Transport(script)
    he.urllib.request.urlopen = t
    return t


_ORIG_URLOPEN = he.urllib.request.urlopen


def _restore_transport():
    he.urllib.request.urlopen = _ORIG_URLOPEN


# ---------------------------------------------------------------------------
# _load_oauth_token
# ---------------------------------------------------------------------------

def test_load_oauth_token():
    print("test_load_oauth_token")
    saved = {k: os.environ.get(k) for k in ("CLAUDE_CONFIG_DIR", "HOME")}
    try:
        with tempfile.TemporaryDirectory() as cfg, tempfile.TemporaryDirectory() as home:
            # 1. CLAUDE_CONFIG_DIR wins.
            Path(cfg, ".credentials.json").write_text(
                json.dumps({"claudeAiOauth": {"accessToken": "tok-cfg"}}))
            (Path(home) / ".claude").mkdir()
            (Path(home) / ".claude" / ".credentials.json").write_text(
                json.dumps({"claudeAiOauth": {"accessToken": "tok-home"}}))
            os.environ["CLAUDE_CONFIG_DIR"] = cfg
            os.environ["HOME"] = home
            check(he._load_oauth_token() == "tok-cfg", "CLAUDE_CONFIG_DIR takes precedence")

            # 2. HOME fallback when CLAUDE_CONFIG_DIR unset.
            del os.environ["CLAUDE_CONFIG_DIR"]
            check(he._load_oauth_token() == "tok-home", "HOME/.claude fallback")

            # 3. CLAUDE_CONFIG_DIR present but missing file -> HOME fallback.
            with tempfile.TemporaryDirectory() as empty:
                os.environ["CLAUDE_CONFIG_DIR"] = empty
                check(he._load_oauth_token() == "tok-home",
                      "missing cfg file falls through to HOME")
            del os.environ["CLAUDE_CONFIG_DIR"]

        # 4. No readable source -> "".
        with tempfile.TemporaryDirectory() as bare:
            os.environ["HOME"] = bare  # no .claude here
            check(he._load_oauth_token() == "", "no source -> empty string")

            # 5. Malformed JSON -> "".
            (Path(bare) / ".claude").mkdir()
            (Path(bare) / ".claude" / ".credentials.json").write_text("not json {")
            check(he._load_oauth_token() == "", "malformed JSON -> empty string")

            # 6. Missing claudeAiOauth key -> "".
            (Path(bare) / ".claude" / ".credentials.json").write_text(json.dumps({"foo": 1}))
            check(he._load_oauth_token() == "", "missing claudeAiOauth -> empty string")

            # 7. claudeAiOauth present but empty accessToken -> "".
            (Path(bare) / ".claude" / ".credentials.json").write_text(
                json.dumps({"claudeAiOauth": {"accessToken": ""}}))
            check(he._load_oauth_token() == "", "empty accessToken -> empty string")

            # 8. Non-UTF-8 bytes -> "" (UnicodeDecodeError caught, not raised).
            (Path(bare) / ".claude" / ".credentials.json").write_bytes(b"\xff\xfe\x00\x01bad")
            check(he._load_oauth_token() == "", "non-UTF-8 credential -> empty string")

            # 9. Valid JSON but non-object top level ([], null) -> "" (no
            #    AttributeError from data.get()).
            (Path(bare) / ".claude" / ".credentials.json").write_text("[]")
            check(he._load_oauth_token() == "", "non-object JSON (list) only source -> empty string")
            (Path(bare) / ".claude" / ".credentials.json").write_text("null")
            check(he._load_oauth_token() == "", "non-object JSON (null) only source -> empty string")

            # 10. Non-object JSON in the CLAUDE_CONFIG_DIR override still falls
            #     through to a valid HOME credential.
            (Path(bare) / ".claude" / ".credentials.json").write_text(
                json.dumps({"claudeAiOauth": {"accessToken": "tok-home2"}}))
            with tempfile.TemporaryDirectory() as badcfg:
                (Path(badcfg) / ".credentials.json").write_text("[]")
                os.environ["CLAUDE_CONFIG_DIR"] = badcfg
                check(he._load_oauth_token() == "tok-home2",
                      "non-object override JSON falls through to HOME")
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---------------------------------------------------------------------------
# _haiku_request_once — header/token build + classification
# ---------------------------------------------------------------------------

def test_request_headers_success():
    print("test_request_headers_success")
    t = _with_transport([lambda req: _FakeResp(_grade_payload(92))])
    try:
        result, stale = he._haiku_request_once("PROMPT-BODY", "tok-XYZ")
    finally:
        _restore_transport()
    check(result == {"status": "pass", "score": 92, "violations": []}, "pass grade mapped")
    check(stale is False, "success -> stale_auth False")
    req = t.requests[0]
    # urllib capitalizes header keys: Authorization, Anthropic-beta, etc.
    check(req.get_header("Authorization") == "Bearer tok-XYZ", "Authorization: Bearer <token>")
    check(req.get_header("Anthropic-beta") == "oauth-2025-04-20", "anthropic-beta header present")
    check(req.get_header("Anthropic-version") == "2023-06-01", "anthropic-version preserved")
    check(req.get_header("X-api-key") is None, "x-api-key header ABSENT")
    # Body carries the filled prompt and haiku model.
    sent = json.loads(req.data.decode("utf-8"))
    check(sent["model"] == "claude-haiku-4-5-20251001", "haiku model in body")
    check(sent["messages"][0]["content"] == "PROMPT-BODY", "filled prompt in body")


def test_fail_grade():
    print("test_fail_grade")
    t = _with_transport([lambda req: _FakeResp(_grade_payload(40, ["tone"]))])
    try:
        result, stale = he._haiku_request_once("p", "tok")
    finally:
        _restore_transport()
    check(result["status"] == "fail" and result["score"] == 40, "score<85 -> fail")
    check(result["violations"] == ["tone"], "violations passed through")
    check(stale is False, "fail grade -> stale_auth False")


def test_401_signals_stale():
    print("test_401_signals_stale")
    def raise401(req):
        raise _http_error(401, '{"error":"unauthorized"}')
    _with_transport([raise401])
    try:
        result, stale = he._haiku_request_once("p", "tok")
    finally:
        _restore_transport()
    check(result["status"] == "unavailable" and result["reason"] == "auth", "401 -> auth unavailable")
    check(stale is True, "401 -> stale_auth True (retry signal)")


def test_403_unauthorized_body_no_stale():
    print("test_403_unauthorized_body_no_stale")
    def raise403(req):
        raise _http_error(403, '{"error":{"message":"unauthorized for this resource"}}')
    _with_transport([raise403])
    try:
        result, stale = he._haiku_request_once("p", "tok")
    finally:
        _restore_transport()
    check(result["reason"] == "auth", "403 unauthorized-body -> auth")
    check(stale is False, "403 (not 401) -> stale_auth False (no retry signal)")


def test_billing_classification():
    print("test_billing_classification")
    def raiseBilling(req):
        raise _http_error(400, '{"error":{"message":"Your credit balance is too low"}}')
    _with_transport([raiseBilling])
    try:
        result, stale = he._haiku_request_once("p", "tok")
    finally:
        _restore_transport()
    check(result["reason"] == "billing", "credit-balance 400 -> billing")
    check(stale is False, "billing -> stale_auth False (no retry)")


def test_network_5xx():
    print("test_network_5xx")
    def raise503(req):
        raise _http_error(503, "upstream")
    _with_transport([raise503])
    try:
        result, stale = he._haiku_request_once("p", "tok")
    finally:
        _restore_transport()
    check(result["reason"] == "network" and result["retryable"] is True, "5xx -> retryable network")
    check(stale is False, "5xx -> stale_auth False")


# ---------------------------------------------------------------------------
# _call_haiku — token_missing + re-read-on-401 retry
# ---------------------------------------------------------------------------

def _set_prompt(val="grade: {RESPONSE}"):
    he.QUALITY_CHECK_PROMPT = val


def test_call_haiku_token_missing():
    print("test_call_haiku_token_missing")
    saved_loader = he._load_oauth_token
    _set_prompt()
    he._load_oauth_token = lambda: ""
    try:
        result = he._call_haiku("some response")
    finally:
        he._load_oauth_token = saved_loader
    check(result["status"] == "unavailable" and result["reason"] == "token_missing",
          "empty token -> token_missing")


def test_call_haiku_retry_different_token():
    print("test_call_haiku_retry_different_token")
    saved_loader = he._load_oauth_token
    _set_prompt()
    tokens = iter(["tok-stale", "tok-fresh"])
    he._load_oauth_token = lambda: next(tokens)

    def first401(req):
        raise _http_error(401, "unauthorized")

    def then200(req):
        return _FakeResp(_grade_payload(97))

    t = _with_transport([first401, then200])
    try:
        result = he._call_haiku("resp")
    finally:
        _restore_transport()
        he._load_oauth_token = saved_loader
    check(result["status"] == "pass" and result["score"] == 97, "retry with fresh token -> pass")
    check(len(t.requests) == 2, "urlopen called exactly twice (retry happened)")
    check(t.requests[0].get_header("Authorization") == "Bearer tok-stale", "first call used stale token")
    check(t.requests[1].get_header("Authorization") == "Bearer tok-fresh", "retry used fresh token")


def test_call_haiku_no_retry_same_token():
    print("test_call_haiku_no_retry_same_token")
    saved_loader = he._load_oauth_token
    _set_prompt()
    he._load_oauth_token = lambda: "tok-same"

    def always401(req):
        raise _http_error(401, "unauthorized")

    t = _with_transport([always401])  # only ONE scripted response -> proves single call
    try:
        result = he._call_haiku("resp")
    finally:
        _restore_transport()
        he._load_oauth_token = saved_loader
    check(result["reason"] == "auth", "same token on 401 -> auth unavailable")
    check(len(t.requests) == 1, "no retry when re-read yields identical token")


def test_call_haiku_no_retry_empty_reread():
    print("test_call_haiku_no_retry_empty_reread")
    saved_loader = he._load_oauth_token
    _set_prompt()
    tokens = iter(["tok-first", ""])  # refresher wrote an empty/absent token
    he._load_oauth_token = lambda: next(tokens)

    def always401(req):
        raise _http_error(401, "unauthorized")

    t = _with_transport([always401])
    try:
        result = he._call_haiku("resp")
    finally:
        _restore_transport()
        he._load_oauth_token = saved_loader
    check(result["reason"] == "auth", "empty re-read -> auth unavailable")
    check(len(t.requests) == 1, "no retry when re-read yields empty token")


def test_call_haiku_no_retry_on_403():
    print("test_call_haiku_no_retry_on_403")
    saved_loader = he._load_oauth_token
    _set_prompt()
    tokens = iter(["tok-a", "tok-b"])  # a re-read WOULD yield a different token
    he._load_oauth_token = lambda: next(tokens)

    def always403(req):
        raise _http_error(403, '{"error":{"message":"unauthorized"}}')

    t = _with_transport([always403])  # only ONE scripted response
    try:
        result = he._call_haiku("resp")
    finally:
        _restore_transport()
        he._load_oauth_token = saved_loader
    check(result["reason"] == "auth", "403 -> auth unavailable")
    check(len(t.requests) == 1, "no retry on 403 even though re-read yields a different token")


def main():
    test_load_oauth_token()
    test_request_headers_success()
    test_fail_grade()
    test_401_signals_stale()
    test_403_unauthorized_body_no_stale()
    test_billing_classification()
    test_network_5xx()
    test_call_haiku_token_missing()
    test_call_haiku_retry_different_token()
    test_call_haiku_no_retry_same_token()
    test_call_haiku_no_retry_empty_reread()
    test_call_haiku_no_retry_on_403()
    print()
    if _FAILS:
        print(f"RESULT: {len(_FAILS)} FAILED")
        raise SystemExit(1)
    print("RESULT: ALL PASSED")


if __name__ == "__main__":
    main()
