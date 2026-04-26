#!/usr/bin/env python3
"""
Atlas Host-Executor Bridge

Watches ~/.atlas/host-tasks/pending/ for task request JSON files.
For each task:
  1. Validate tier (reject Tier 4, restrict Tier 1 to read-only)
  2. cd to project directory
  3. Run: claude -p --model {model} "prompt"
  4. Capture stdout + exit code
  5. Write result to ~/.atlas/host-tasks/completed/{task-id}.json
  6. Auto-push commits to origin
  7. Log to audit

This runs on the VPS host (not in a container) so full Python hooks fire.
Systemd service: atlas-host-executor.service
"""

import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Paths
#
# ATLAS_DIR and NANOCLAW_DIR accept env-var overrides so the service can
# migrate to a different POSIX user without the path resolution silently
# changing under it (Path.home() resolves to the running user's $HOME, which
# becomes a different tree the moment the systemd unit's User= field changes).
# Defaults preserve historical behavior for laptops and any deployment that
# hasn't set the env vars yet. Audit doc 1.A.6 condition (b) tracks this
# decoupling — atlas-command (the live mission-control surface) already
# uses this pattern; host-executor adopts it here so future user-account
# migration work doesn't require simultaneous code + deploy changes.
ATLAS_DIR = Path(os.environ.get("ATLAS_DIR") or str(Path.home() / ".atlas"))
NANOCLAW_DIR = Path(os.environ.get("NANOCLAW_DIR") or str(Path.home() / "nanoclaw"))
PENDING_DIR = ATLAS_DIR / "host-tasks" / "pending"
COMPLETED_DIR = ATLAS_DIR / "host-tasks" / "completed"
OUTPUTS_DIR = ATLAS_DIR / "host-tasks" / "outputs"
AUDIT_DIR = ATLAS_DIR / "audit"
IPC_DIR = NANOCLAW_DIR / "data" / "ipc" / "atlas_main" / "messages"

# Config
POLL_INTERVAL = 5  # seconds
TASK_TIMEOUT = 600  # 10 minutes max per task
MAX_OUTPUT_SIZE = 50_000  # chars to keep in result summary
AUTH_ERROR_PATTERNS = ["authentication_error", "OAuth token has expired", "401", "token expired"]
OUTAGE_ERROR_PATTERNS = [
    "500 internal server error", "502 bad gateway", "503 service",
    "529", "overloaded", "connection refused", "connection reset",
    "service temporarily unavailable", "outage recovery in progress",
]

# Outage tracking — self-healing mode
outage_mode = False
outage_started_at = 0.0
outage_alert_sent = False
HEALTH_CHECK_BACKOFF = [30, 60, 120, 300]  # seconds: 30s → 1m → 2m → 5m cap
health_check_attempt = 0
# Port for the quality-check HTTP server (containers POST here for Haiku grading).
# Hardcoded 3003 to avoid colliding with atlas-bridge.service which owns
# 127.0.0.1:3002. Must stay in lockstep with the container-side constant in
# container/agent-runner/src/governance/response-interceptor.ts — there is no
# config channel to propagate an override into containers, so changing this
# constant requires editing both files in the same commit.
QUALITY_CHECK_PORT = 3003


# --- Quality Check HTTP Server ---
# Runs in a background thread. Containers POST response text here,
# host-executor calls Haiku with the real API key, returns the score.
# This avoids putting API keys in containers and works around OAuth
# not being supported on the /v1/messages endpoint.

def _load_anthropic_api_key() -> str:
    """Read ANTHROPIC_API_KEY from ~/.atlas/.env or environment."""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        return key
    env_path = ATLAS_DIR / ".env"
    try:
        for line in env_path.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return ""


def _load_quality_check_token() -> str:
    """Read QUALITY_CHECK_TOKEN from ~/.atlas/.env.

    File-only by design — the container-side reader has no env-propagation
    channel, so allowing host-side env-overrides would cause silent host/
    container mismatches (host endpoint requires the env-token while every
    container POST sends an empty/old-file token and gets 401, silently
    disabling the gate). Single source of truth: ~/.atlas/.env.

    Direct-parse is intentional (vs systemd EnvironmentFile=) because
    git-sync.sh restarts services without daemon-reload, so any new
    EnvironmentFile= directive would silently fail to apply on first deploy.
    """
    env_path = ATLAS_DIR / ".env"
    try:
        for line in env_path.read_text().splitlines():
            if line.startswith("QUALITY_CHECK_TOKEN="):
                return line.split("=", 1)[1].strip()
    except (FileNotFoundError, PermissionError, OSError):
        # Treat any read failure (missing file, permission denied, broken
        # filesystem) as "no token configured". main() handles the empty-
        # token case by starting in DEGRADED mode rather than crashing.
        pass
    return ""


# Loaded once at startup by main(); referenced by QualityCheckHandler.do_POST
# for constant-time auth comparison. See main() for the fail-closed gate.
QUALITY_CHECK_TOKEN: str = ""

# Quality-check prompt: repo-owned single source of truth. main() loads at startup
# and refuses to run if missing. Container bundles the SAME file into its image
# (Dockerfile COPY → /opt/nanoclaw/quality-check-prompt.md). Both sides read the
# same content; PR review covers prompt changes. Replaces the old TS-scraping
# pattern that silently fell back to a minimal prompt on parse failure.
QUALITY_CHECK_PROMPT_PATH = (
    NANOCLAW_DIR / "container" / "agent-runner" / "src" / "governance" / "quality-check-prompt.md"
)
QUALITY_CHECK_PROMPT: str = ""
# 12-char SHA-256 of the loaded prompt text. Emitted at startup and on
# unavailable-path log lines so stale-image deploys (host updated, container
# image not rebuilt) are visible without poking at deployed files.
QUALITY_CHECK_PROMPT_SHA: str = ""

# In-flight cap protects the Anthropic budget from a runaway client. The
# bearer token is shared across all containers (RO mount), so auth alone does
# not stop a compromised container from flooding /quality-check. Over-cap
# requests return HTTP 429 with status=unavailable+reason=busy immediately —
# no upstream Haiku call.
QUALITY_CHECK_INFLIGHT_CAP = 8
QUALITY_CHECK_INFLIGHT_LOCK = threading.Lock()
QUALITY_CHECK_INFLIGHT_COUNT = 0

# Operator-alert dedup state lives on disk so the dedup window survives
# host-executor restarts. Without persistence, a restart loop would re-fire
# one alert per reason per restart. Atomic writes via tempfile + os.replace
# under the lock prevent half-written JSON from disabling dedup. Hard reasons
# (billing, auth, token_missing) alert immediately and dedupe 30 min. Soft
# reasons (timeout, network) require N=3 in 5 min before alerting, then 30 min
# dedup. Other reasons (busy, parse, api_error, prompt_missing) are loud-logged
# but NOT alerted — they'd drown legitimate signals.
ALERT_DEDUP_PATH = ATLAS_DIR / "state" / "quality-check-alert-dedup.json"
ALERT_DEDUP_LOCK = threading.Lock()
ALERT_HARD_REASONS = frozenset({"billing", "auth", "token_missing"})
ALERT_SOFT_REASONS = frozenset({"timeout", "network"})
ALERT_DEDUP_WINDOW_S = 1800   # 30 min
ALERT_SOFT_THRESHOLD = 3      # consecutive failures
ALERT_SOFT_WINDOW_S = 300     # 5 min rolling window


def _unavailable(reason: str, retryable: bool, detail: str) -> dict:
    """Build the canonical unavailable response dict. Detail is truncated to
    keep the wire body bounded; container side does not need full upstream
    error text (already in host stderr / Telegram alert)."""
    return {
        "status": "unavailable",
        "reason": reason,
        "retryable": bool(retryable),
        "detail": (detail or "")[:300],
    }


def _load_alert_dedup_state() -> dict:
    """Read dedup state from disk; return empty default on any read error.
    Caller MUST hold ALERT_DEDUP_LOCK."""
    try:
        return json.loads(ALERT_DEDUP_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"reasons": {}}


def _save_alert_dedup_state(state: dict) -> None:
    """Atomic write: tmpfile + os.replace under the lock so a crash mid-write
    cannot leave invalid JSON that disables dedup on next read.
    Caller MUST hold ALERT_DEDUP_LOCK."""
    try:
        ALERT_DEDUP_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        pass  # parent already exists with different perms — proceed
    tmp = ALERT_DEDUP_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, ALERT_DEDUP_PATH)


def _maybe_send_operator_alert(reason: str, detail: str) -> None:
    """Decide whether to alert based on persistent dedup state, then send.
    Lock is released BEFORE send_telegram_alert so file IPC + sqlite read
    don't block other quality-check threads racing to update dedup."""
    if reason not in ALERT_HARD_REASONS and reason not in ALERT_SOFT_REASONS:
        return  # busy / parse / api_error / prompt_missing — loud-log only
    now = time.time()
    should_send = False
    with ALERT_DEDUP_LOCK:
        state = _load_alert_dedup_state()
        rs = state.setdefault("reasons", {}).setdefault(
            reason, {"last_sent": 0.0, "soft_window_start": 0.0, "soft_count": 0}
        )
        if reason in ALERT_HARD_REASONS:
            if now - float(rs.get("last_sent", 0.0)) >= ALERT_DEDUP_WINDOW_S:
                rs["last_sent"] = now
                _save_alert_dedup_state(state)
                should_send = True
        else:  # SOFT
            if now - float(rs.get("soft_window_start", 0.0)) > ALERT_SOFT_WINDOW_S:
                rs["soft_window_start"] = now
                rs["soft_count"] = 0
            rs["soft_count"] = int(rs.get("soft_count", 0)) + 1
            if (
                rs["soft_count"] >= ALERT_SOFT_THRESHOLD
                and now - float(rs.get("last_sent", 0.0)) >= ALERT_DEDUP_WINDOW_S
            ):
                rs["last_sent"] = now
                rs["soft_count"] = 0
                _save_alert_dedup_state(state)
                should_send = True
            else:
                _save_alert_dedup_state(state)
    if should_send:
        try:
            send_telegram_alert(
                f"[OPS] quality-check {reason}: {detail[:200]} (sha={QUALITY_CHECK_PROMPT_SHA})"
            )
        except Exception as e:
            log(f"Operator alert send failed (reason={reason}): {e}")


def _call_haiku(response_text: str) -> dict:
    """Call Haiku /v1/messages with direct API key. Returns tri-state dict.

    Pass:        {"status":"pass", "score":N, "violations":[]}
    Fail:        {"status":"fail", "score":N, "violations":[...]}
    Unavailable: {"status":"unavailable", "reason":<R>, "retryable":bool, "detail":"..."}

    Reason taxonomy (must stay in lockstep with response-interceptor.ts
    UnavailableReason union and audit doc 1.A.6 §5.4):
      billing       — credit/quota exhaustion. NOT retryable; operator alert.
      auth          — 401/unauthorized. NOT retryable; operator alert.
      token_missing — ANTHROPIC_API_KEY absent. NOT retryable; operator alert.
      network       — 5xx/URLError. Retryable; soft-window alert (N=3 in 5min).
      timeout       — request timeout. Retryable; soft-window alert.
      parse         — Haiku JSON unparseable. NOT retryable; loud-log only.
      api_error     — other 4xx / unclassified exception. NOT retryable; loud-log.
    """
    api_key = _load_anthropic_api_key()
    if not api_key:
        return _unavailable("token_missing", False, "ANTHROPIC_API_KEY not in ~/.atlas/.env or env")

    if not QUALITY_CHECK_PROMPT:
        # main() refuses to start when the prompt file is missing, so this
        # branch is defensive only. If we somehow reach here, fail-closed.
        return _unavailable("api_error", False, "QUALITY_CHECK_PROMPT not loaded — host startup misconfigured")

    filled_prompt = QUALITY_CHECK_PROMPT.replace("{RESPONSE}", response_text[:4000])

    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": filled_prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            text = data.get("content", [{}])[0].get("text", "{}")
            # Strip markdown fences (```json ... ```)
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            # Strip any preamble text before the JSON object
            json_start = text.find("{")
            if json_start > 0:
                text = text[json_start:]
            # Strip any trailing text after the JSON object
            json_end = text.rfind("}")
            if json_end >= 0:
                text = text[:json_end + 1]
            try:
                result = json.loads(text)
            except json.JSONDecodeError:
                # Haiku response may be truncated at max_tokens.
                # Try to salvage: close any open arrays/objects.
                salvage = text.rstrip()
                # Count unclosed brackets
                opens = salvage.count("[") - salvage.count("]")
                braces = salvage.count("{") - salvage.count("}")
                salvage += "]" * max(opens, 0)
                salvage += "}" * max(braces, 0)
                try:
                    result = json.loads(salvage)
                    log(f"Haiku response truncated at {len(text)} chars — salvaged with bracket closing")
                except json.JSONDecodeError as e2:
                    log(f"Haiku JSON parse failed even after salvage: {e2}")
                    log(f"Text length: {len(text)}, first 200: {repr(text[:200])}")
                    log(f"Last 200: {repr(text[-200:])}")
                    return _unavailable("parse", False, f"Haiku JSON parse: {str(e2)}")
            # Map Haiku's score+violations into the tri-state contract. Score
            # threshold semantics preserved from prior versions (>=85 pass).
            raw_score = result.get("score")
            score = raw_score if isinstance(raw_score, (int, float)) else 50
            raw_violations = result.get("violations", [])
            violations = raw_violations if isinstance(raw_violations, list) else []
            status = "pass" if score >= 85 else "fail"
            return {"status": status, "score": score, "violations": violations}
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8")[:500]
        except Exception:
            pass
        body_lower = err_body.lower()
        # Anthropic returns the credit-balance error as 400 with body containing
        # "credit balance is too low" or "insufficient_quota". Both signal a
        # billing exhaustion; not retryable until topped up. Operator alert
        # fires immediately because no in-band retry will recover.
        if "insufficient_quota" in body_lower or "credit balance" in body_lower:
            return _unavailable("billing", False, f"HTTP {e.code}: credit/quota exhausted")
        if e.code == 401 or "unauthorized" in body_lower:
            return _unavailable("auth", False, f"HTTP {e.code}: unauthorized")
        if 500 <= e.code < 600:
            # Upstream server error — retry might recover; classify as network.
            return _unavailable("network", True, f"HTTP {e.code}: upstream error")
        return _unavailable("api_error", False, f"HTTP {e.code}: {err_body[:200]}")
    except urllib.error.URLError as e:
        return _unavailable("network", True, f"Network error: {e.reason}")
    except json.JSONDecodeError as e:
        return _unavailable("parse", False, f"JSON parse error: {str(e)}")
    except TimeoutError:
        return _unavailable("timeout", True, "Anthropic request timed out (10s)")
    except Exception as e:
        return _unavailable("api_error", False, str(e))


class QualityCheckHandler(BaseHTTPRequestHandler):
    """Handles POST /quality-check from containers."""

    def do_POST(self):
        if self.path != "/quality-check":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error": "not found"}')
            return

        # Bearer-token auth. Constant-time compare against QUALITY_CHECK_TOKEN
        # (loaded at startup; main() refuses to start if it's missing). The
        # token is endpoint hardening only — it blocks external callers, not
        # compromised containers (which can read the token off the .env
        # mount). Don't log the header value on auth failure.
        auth_header = self.headers.get("Authorization", "")
        expected = "Bearer " + QUALITY_CHECK_TOKEN
        if not QUALITY_CHECK_TOKEN or not hmac.compare_digest(auth_header, expected):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": "unauthorized"}')
            return

        # In-flight cap. Bearer auth doesn't help against a compromised
        # container (token is in the shared RO .env mount), so cap concurrent
        # handlers to bound the Anthropic spend surface. Over-cap requests
        # return HTTP 429 + status=unavailable+reason=busy immediately —
        # no upstream call. Container side classifies "busy" as retryable.
        global QUALITY_CHECK_INFLIGHT_COUNT
        with QUALITY_CHECK_INFLIGHT_LOCK:
            if QUALITY_CHECK_INFLIGHT_COUNT >= QUALITY_CHECK_INFLIGHT_CAP:
                busy = _unavailable(
                    "busy", True,
                    f"in-flight cap {QUALITY_CHECK_INFLIGHT_CAP} reached"
                )
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(busy).encode("utf-8"))
                # Loud-log only; no operator alert (cap saturation is a
                # capacity signal, not an outage).
                log(f"Quality-check BUSY: in-flight={QUALITY_CHECK_INFLIGHT_COUNT}/{QUALITY_CHECK_INFLIGHT_CAP}")
                return
            QUALITY_CHECK_INFLIGHT_COUNT += 1

        try:
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                response_text = body.get("response", "")

                if not response_text:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b'{"error": "missing response field"}')
                    return

                result = _call_haiku(response_text)

                # Operator alert + log on any unavailable. Loud-log on every
                # unavailable; alert is dedup-gated inside _maybe_send_*.
                if result.get("status") == "unavailable":
                    reason = result.get("reason", "api_error")
                    detail = result.get("detail", "")
                    log(
                        f"Quality-check UNAVAILABLE: reason={reason} "
                        f"detail={detail[:200]} prompt_sha={QUALITY_CHECK_PROMPT_SHA}"
                    )
                    _maybe_send_operator_alert(reason, detail)

                # Tri-state response always HTTP 200 (transitional). Old
                # containers parse score+violations; new containers parse
                # status. Both work.
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode("utf-8"))

            except Exception as e:
                # Handler-level fault → still return tri-state shape so
                # container parser can route as unavailable rather than
                # falling into the legacy score-only branch.
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(_unavailable("api_error", False, str(e))).encode("utf-8"))
        finally:
            with QUALITY_CHECK_INFLIGHT_LOCK:
                QUALITY_CHECK_INFLIGHT_COUNT -= 1

    def log_message(self, format, *args):
        # Suppress default stderr logging — we use our own log()
        pass


def start_quality_check_server():
    """Start the quality check HTTP server in a background thread.

    Binds 0.0.0.0 so containers can reach the host via the docker host gateway
    (host.docker.internal / 172.17.0.1). Auth on the endpoint is tracked as
    a separate P0 follow-up — see plans/1-a-6-host-executor-mission-control-audit.md
    section 5.2. Port defaults to 3003 to keep clear of atlas-bridge on 3002.
    """
    # ThreadingHTTPServer (not the single-threaded HTTPServer) so concurrent
    # CEO-facing quality checks don't serialize behind a slow Haiku call.
    # Cross-review of 0a8adb3 flagged that the single-thread server pinned
    # other requests behind a 10s _call_haiku, and queued callers hit the
    # container-side 12s timeout → checkerUnavailable → governance bypass.
    # Each handler still respects its own per-request timeout (12s container
    # side, 10s on the Anthropic call).
    server = ThreadingHTTPServer(("0.0.0.0", QUALITY_CHECK_PORT), QualityCheckHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log(f"Quality check server started on port {QUALITY_CHECK_PORT}")

# Tier restrictions
TIER_READONLY_FLAG = "--allowedTools Read,Glob,Grep,WebSearch,WebFetch"


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def send_telegram_alert(message: str) -> None:
    """Send an alert to CEO via NanoClaw's IPC system (atlas_main group)."""
    try:
        IPC_DIR.mkdir(parents=True, exist_ok=True)
        # Read main group JID from NanoClaw DB
        import sqlite3
        db_path = NANOCLAW_DIR / "store" / "messages.db"
        if not db_path.exists():
            log(f"Cannot send Telegram alert — DB not found at {db_path}")
            return
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1").fetchone()
        conn.close()
        if not row:
            log("Cannot send Telegram alert — no main group registered")
            return
        main_jid = row[0]

        alert_file = IPC_DIR / f"alert-{int(time.time() * 1000)}.json"
        alert_file.write_text(json.dumps({
            "type": "message",
            "chatJid": main_jid,
            "text": message,
        }))
        log(f"Telegram alert sent via IPC: {message[:100]}...")
    except Exception as e:
        log(f"Failed to send Telegram alert: {e}")


def is_auth_error(stdout: str, stderr: str) -> bool:
    """Detect authentication failures in claude -p output."""
    combined = (stdout + stderr).lower()
    return any(pattern.lower() in combined for pattern in AUTH_ERROR_PATTERNS)


def is_outage_error(stdout: str, stderr: str) -> bool:
    """Detect Anthropic API outage (distinct from auth failure)."""
    combined = (stdout + stderr).lower()
    return any(pattern in combined for pattern in OUTAGE_ERROR_PATTERNS)


def is_api_healthy() -> bool:
    """Check if Anthropic API is reachable. Any HTTP response = healthy.
    Only network-level failures (timeout, connection refused) = unhealthy."""
    try:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            method="GET",
            headers={"anthropic-version": "2023-06-01"},
        )
        urllib.request.urlopen(req, timeout=10)
        return True
    except urllib.error.HTTPError:
        # HTTP error (401, 405, etc.) means the API is reachable
        return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def enter_outage_mode() -> None:
    """Enter outage mode — skip task processing until API recovers."""
    global outage_mode, outage_started_at, outage_alert_sent, health_check_attempt
    if outage_mode:
        return
    outage_mode = True
    outage_started_at = time.time()
    health_check_attempt = 0
    log("Entering outage mode — tasks will be held until API recovers")

    if not outage_alert_sent:
        outage_alert_sent = True
        send_telegram_alert(
            "*Host-Executor: API Outage Detected*\n\n"
            "Claude API is unreachable. Pending tasks will be held and "
            "retried automatically when the outage ends.\n\n"
            "No action needed unless this persists for hours."
        )


def exit_outage_mode() -> None:
    """Exit outage mode — API is back, resume processing."""
    global outage_mode, outage_alert_sent, health_check_attempt
    downtime_min = round((time.time() - outage_started_at) / 60)
    outage_mode = False
    outage_alert_sent = False
    health_check_attempt = 0
    log(f"Exiting outage mode — API recovered after ~{downtime_min} minutes")
    send_telegram_alert(
        f"*Host-Executor: API Recovered*\n\n"
        f"Auto-recovered after ~{downtime_min} minute(s). "
        f"Resuming task processing."
    )


def log_audit(entity: str, event: dict) -> None:
    """Append an audit event to the entity's daily audit log."""
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        entity_dir = AUDIT_DIR / entity
        entity_dir.mkdir(parents=True, exist_ok=True)
        audit_file = entity_dir / f"{today}.jsonl"
        with open(audit_file, "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        log(f"Audit log error: {e}")


def get_commits_since(project_dir: str, before_hash: str) -> list[str]:
    """Get commit hashes made since a given hash."""
    try:
        result = subprocess.run(
            ["git", "log", f"{before_hash}..HEAD", "--format=%h", "--reverse"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split("\n")
    except Exception:
        pass
    return []


def get_head_hash(project_dir: str) -> str:
    """Get current HEAD commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def auto_push(project_dir: str, entity: str) -> bool:
    """Push commits to origin. Returns True on success."""
    try:
        result = subprocess.run(
            ["git", "push", "origin", "HEAD"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            log(f"Auto-push success: {project_dir}")
            return True
        else:
            log(f"Auto-push failed: {result.stderr.strip()}")
            log_audit(entity, {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "host_executor_push_failed",
                "project_dir": project_dir,
                "error": result.stderr.strip()[:500],
            })
            return False
    except Exception as e:
        log(f"Auto-push error: {e}")
        return False



def merge_worktree_branches(project_dir: str) -> list[str]:
    """Find and merge worktree branches created by claude -p --worktree.

    After claude -p exits, commits may be in a worktree branch rather than
    the main branch. This merges them back so commit detection and auto-push
    work correctly.
    """
    merged = []
    try:
        # List all worktrees
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=project_dir, capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return merged

        # Parse worktree branches (skip main/master)
        branches = []
        for line in result.stdout.split("\n"):
            if line.startswith("branch "):
                branch = line[7:].replace("refs/heads/", "")
                if branch not in ("main", "master"):
                    branches.append(branch)

        # Get current branch
        current = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=project_dir, capture_output=True, text=True, timeout=5
        )
        current_branch = current.stdout.strip() if current.returncode == 0 else "main"

        for branch in branches:
            # Check if branch has commits ahead of current
            ahead = subprocess.run(
                ["git", "log", f"{current_branch}..{branch}", "--oneline"],
                cwd=project_dir, capture_output=True, text=True, timeout=10
            )
            if ahead.stdout.strip():
                # Merge the branch
                merge = subprocess.run(
                    ["git", "merge", branch, "--no-edit"],
                    cwd=project_dir, capture_output=True, text=True, timeout=30
                )
                if merge.returncode == 0:
                    merged.append(branch)
                    log(f"  Merged worktree branch: {branch}")
                    # Clean up branch
                    subprocess.run(
                        ["git", "branch", "-d", branch],
                        cwd=project_dir, capture_output=True, text=True, timeout=10
                    )
                else:
                    log(f"  WARN: Failed to merge worktree branch {branch}: {merge.stderr[:100]}")

        # Clean up any stale worktrees
        subprocess.run(
            ["git", "worktree", "prune"],
            cwd=project_dir, capture_output=True, text=True, timeout=10
        )
    except Exception as e:
        log(f"  Worktree merge error: {e}")
    return merged


def process_task(task_path: Path) -> None:
    """Process a single task request."""
    task_id = None
    entity = "unknown"

    try:
        task = json.loads(task_path.read_text())
        task_id = task.get("task_id", task_path.stem)
        entity = task.get("entity", "unknown")
        project_dir = task.get("project_dir", "")
        prompt = task.get("prompt", "")
        tier = task.get("tier", 2)
        model = task.get("model", "sonnet")
        callback_group = task.get("callback_group", "")

        log(f"Processing task {task_id} | entity={entity} tier={tier} model={model}")
        log(f"  project: {project_dir}")
        log(f"  prompt: {prompt[:100]}...")

        # Tier validation (must apply to ALL task types including missions)
        if tier >= 4:
            write_result(task_id, entity, "rejected", 1,
                         "Tier 4 tasks are CEO-only. Cannot execute autonomously.",
                         [], False)
            task_path.unlink()
            return

        # --- MISSION TASK ROUTING ---
        # If task type is "mission", delegate to mission_executor module
        if task.get("type") == "mission":
            try:
                import sys as _m_sys
                _m_sys.path.insert(0, str(ATLAS_DIR / "lib"))
                # SSRF scan on mission prompts
                import re as _mission_re
                from ssrf import validate_endpoint_url as _m_validate
                _m_urls = _mission_re.findall(r'https?://[^\s\"\'<>]+', prompt)
                for _m_url in _m_urls:
                    _m_validate(_m_url)
                from mission_executor import process_mission
                mission_result = process_mission(task, log_fn=log)
                write_result(task_id, entity,
                             mission_result.get("status", "error"), 0,
                             json.dumps(mission_result, indent=2),
                             [], False)
                if callback_group:
                    summary = f"Mission {task_id}: {mission_result.get('status')}"
                    outputs = mission_result.get("outputs", {})
                    summary += f" | {len([v for v in outputs.values() if v])}/{len(outputs)} outputs"
                    send_telegram_result(callback_group, summary, task_id, entity)
            except Exception as e:
                log(f"Mission execution error: {e}")
                write_result(task_id, entity, "error", 1, str(e), [], False)
            task_path.unlink()
            return

        # Validate project directory exists
        if not project_dir or not os.path.isdir(project_dir):
            write_result(task_id, entity, "error", 1,
                         f"Project directory not found: {project_dir}",
                         [], False)
            task_path.unlink()
            return



        # --- SSRF PROTECTION ---
        # Scan prompt for URLs resolving to private/internal addresses.
        # Blocks prompt injection like "fetch http://localhost:3002"
        try:
            import re as _re
            import sys as _ssrf_sys
            _ssrf_sys.path.insert(0, str(ATLAS_DIR / "lib"))
            from ssrf import validate_endpoint_url
            urls_in_prompt = _re.findall(r'https?://[^\s\"\'<>]+', prompt)
            for url in urls_in_prompt:
                validate_endpoint_url(url)
            if urls_in_prompt:
                log(f"  SSRF check passed: {len(urls_in_prompt)} URL(s) validated")
        except ValueError as ssrf_err:
            log(f"  SSRF BLOCKED: {ssrf_err}")
            write_result(task_id, entity, "rejected", 1,
                         f"SSRF protection: {ssrf_err}",
                         [], False)
            task_path.unlink()
            return
        except ImportError:
            log("  WARNING: ssrf module not found, skipping URL validation")

        # --- MULTI-PROVIDER ROUTING ---
        # If the task specifies a task_type that matches the routing table,
        # try atlas.route() first. This sends research to Sonar, classification
        # to Groq, lookups to Grok — skipping Claude for pure-text tasks.
        task_type = task.get("task_type", "")
        ROUTE_ELIGIBLE_TYPES = {
            "research", "quick_lookup", "deep_research",
            "classification", "extraction",
            "market_signal", "social_monitoring", "cron_check",
            "document_summary",
            "mechanical_code", "scaffold", "code_review", "judgment_code",
        }
        if task_type in ROUTE_ELIGIBLE_TYPES:
            try:
                import sys as _sys
                _sys.path.insert(0, str(ATLAS_DIR / "lib"))
                from providers import route as atlas_route
                route_result = atlas_route(task_type, prompt, entity=entity)
                if route_result.success:
                    log(f"  Routed via atlas.route() -> {route_result.provider}/{route_result.model} ({route_result.duration_seconds:.1f}s)")
                    write_result(task_id, entity, "success", 0,
                                 route_result.content[:MAX_OUTPUT_SIZE],
                                 [], False)
                    task_path.unlink()
                    if callback_group and route_result.content:
                        send_telegram_result(callback_group, route_result.content, task_id, entity)
                    return
                else:
                    log(f"  atlas.route() failed ({route_result.error}), falling back to claude -p")
            except Exception as e:
                log(f"  atlas.route() import error ({e}), falling back to claude -p")

        # Record HEAD before execution for commit tracking
        head_before = get_head_hash(project_dir)

        # Build claude command
        cmd = ["claude", "-p", "--dangerously-skip-permissions", "--model", model, "-n", f"{entity}:{prompt[:40]}"]

        # Tier 1: read-only (no code modifications)
        if tier == 1:
            cmd.extend(["--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch"])

        # Tier 2+: use worktree isolation to prevent file conflicts
        if tier >= 2:
            cmd.append("--worktree")

        # Run claude -p with the prompt on stdin
        start_time = time.time()
        result = subprocess.run(
            cmd,
            input=prompt,
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=TASK_TIMEOUT,
            env={**os.environ, "CLAUDE_CODE_ENTRY_POINT": "host-executor"},
        )
        duration_ms = int((time.time() - start_time) * 1000)

        stdout = result.stdout or ""
        stderr = result.stderr or ""
        exit_code = result.returncode

        # Detect outage errors — hold task for retry, don't delete
        if is_outage_error(stdout, stderr):
            enter_outage_mode()
            log(f"Task {task_id} hit outage — holding in pending for retry")
            # DON'T delete the task file — it stays in pending for retry
            return

        # Detect auth failure — alert CEO immediately, don't silently fail
        if is_auth_error(stdout, stderr):
            # First check if this is actually an outage masquerading as auth error
            if not is_api_healthy():
                enter_outage_mode()
                log(f"Task {task_id} auth error but API unreachable — treating as outage, holding for retry")
                return

            auth_msg = (
                "*Host-Executor Auth Failure*\n\n"
                f"Task `{task_id}` for {entity} failed due to expired authentication.\n\n"
                "Run on your laptop:\n"
                "`scp ~/.claude/.credentials.json root@5.78.190.56:/home/atlas/.claude/.credentials.json`\n\n"
                "Or SSH and run:\n"
                "`/home/atlas/scripts/refresh-claude-auth.sh`"
            )
            send_telegram_alert(auth_msg)
            write_result(task_id, entity, "error", exit_code,
                         "Authentication expired. CEO alerted on Telegram.",
                         [], False)
            task_path.unlink()
            log(f"Task {task_id} failed: auth expired. CEO alerted.")
            return

        # Truncate output for result summary
        result_summary = stdout[:MAX_OUTPUT_SIZE]
        if len(stdout) > MAX_OUTPUT_SIZE:
            result_summary += f"\n... (truncated, full output: {len(stdout)} chars)"

        # Save full output
        full_output_path = OUTPUTS_DIR / f"{task_id}.txt"
        full_output_path.write_text(stdout)

        # Merge any worktree branches back to main before commit detection
        if tier >= 2:
            wt_merged = merge_worktree_branches(project_dir)
            if wt_merged:
                log(f"  Merged {len(wt_merged)} worktree branch(es)")

        # Check for new commits (now includes worktree merges)
        new_commits = get_commits_since(project_dir, head_before) if head_before else []
        pushed = False

        # Auto-push if there are new commits
        if new_commits:
            pushed = auto_push(project_dir, entity)

        status = "success" if exit_code == 0 else "error"

        write_result(task_id, entity, status, exit_code, result_summary,
                     new_commits, pushed, str(full_output_path),
                     duration_ms, callback_group, prompt)

        # Audit log
        log_audit(entity, {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action": "host_executor_task",
            "task_id": task_id,
            "tier": tier,
            "model": model,
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "commits": new_commits,
            "pushed": pushed,
        })


        # --- Performance tracking (GStack adoption #6) ---
        try:
            import sys as _perf_sys
            _perf_sys.path.insert(0, str(ATLAS_DIR / "lib"))
            from performance_tracker import track as perf_track
            perf_track("task", task_id, duration_ms / 1000.0, entity=entity, model=model)
        except Exception as e:
            log(f"  Performance tracking error (non-blocking): {e}")

        log(f"Task {task_id} completed: {status} in {duration_ms}ms "
            f"| commits={len(new_commits)} pushed={pushed}")

        if stderr:
            log(f"  stderr: {stderr[:200]}")

        # --- M2 graduation: evaluate clean run criteria ---
        # Think of this like a scorecard — after each Tier 1 cron run, grade it
        # against the 6 clean-run criteria for milestone tracking.
        # Only Tier 1 tasks count toward M2 (Tier 1 = read-only autonomous ops).
        if tier == 1:
            try:
                sys.path.insert(0, str(ATLAS_DIR / "lib"))
                from autonomy_tracker import evaluate_m2_clean_run
                m2_result = evaluate_m2_clean_run(
                    task_id=task_id,
                    run_status=status,
                    result_delivered=bool(result_summary),
                    run_error=stderr[:200] if exit_code != 0 else None,
                )
                m2_eval = m2_result.get("evaluation", {})
                log(f"  M2 eval: clean={m2_eval.get('is_clean')} "
                    f"failed={m2_eval.get('failed_criteria', [])}")
            except Exception as e:
                log(f"  M2 eval failed (non-blocking): {e}")

    except subprocess.TimeoutExpired:
        log(f"Task {task_id} timed out after {TASK_TIMEOUT}s")
        write_result(task_id or "unknown", entity, "error", 1,
                     f"Task timed out after {TASK_TIMEOUT} seconds", [], False)
    except json.JSONDecodeError as e:
        log(f"Invalid task JSON in {task_path}: {e}")
    except Exception as e:
        log(f"Task {task_id} error: {e}")
        write_result(task_id or "unknown", entity, "error", 1,
                     f"Host-executor error: {e}", [], False)
    finally:
        # Remove pending task file — UNLESS in outage mode (task held for retry)
        if not outage_mode:
            try:
                if task_path.exists():
                    task_path.unlink()
            except Exception:
                pass


def write_result(
    task_id: str,
    entity: str,
    status: str,
    exit_code: int,
    result_summary: str,
    commits: list[str],
    pushed: bool,
    full_output_path: str = "",
    duration_ms: int = 0,
    callback_group: str = "",
    prompt: str = "",
) -> None:
    """Write task result to completed/ directory."""
    COMPLETED_DIR.mkdir(parents=True, exist_ok=True)

    result = {
        "task_id": task_id,
        "entity": entity,
        "status": status,
        "exit_code": exit_code,
        "prompt": prompt[:500] if prompt else "",
        "result_summary": result_summary,
        "full_output_path": full_output_path,
        "commits": commits,
        "pushed": pushed,
        "duration_ms": duration_ms,
        "callback_group": callback_group,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }

    result_path = COMPLETED_DIR / f"{task_id}.json"
    result_path.write_text(json.dumps(result, indent=2))
    log(f"Result written: {result_path}")


# --- Escalation file watcher (structural backup) ---
# Tracks which escalation files we've already alerted on.
# If the IPC alert from the container worked, the CEO already knows.
# This catches any escalation the container forgot to notify about.

SHARED_DIR = ATLAS_DIR / "shared"
ESCALATION_SEEN_FILE = ATLAS_DIR / "state" / "escalations-seen.json"


def load_seen_escalations() -> set[str]:
    """Load set of escalation file paths we've already alerted on."""
    try:
        if ESCALATION_SEEN_FILE.exists():
            return set(json.loads(ESCALATION_SEEN_FILE.read_text()))
    except Exception:
        pass
    return set()


def save_seen_escalations(seen: set[str]) -> None:
    """Persist seen escalation set."""
    try:
        ESCALATION_SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        ESCALATION_SEEN_FILE.write_text(json.dumps(sorted(seen)))
    except Exception:
        pass


def check_escalations() -> None:
    """Scan all department escalation directories for new files. Alert CEO on unseen ones."""
    if not SHARED_DIR.exists():
        return

    seen = load_seen_escalations()
    new_found = False

    for dept_dir in sorted(SHARED_DIR.iterdir()):
        if not dept_dir.is_dir():
            continue
        dept = dept_dir.name
        esc_dir = dept_dir / "escalations"
        if not esc_dir.exists():
            continue

        for esc_file in sorted(esc_dir.glob("*.md")):
            file_key = str(esc_file)
            if file_key in seen:
                continue

            # New escalation — read first few lines for summary
            try:
                content = esc_file.read_text(encoding="utf-8")
                # Extract title from first heading or first line
                title = "Unknown"
                for line in content.split("\n"):
                    line = line.strip()
                    if line.startswith("# "):
                        title = line[2:].strip()
                        break
                    elif line and title == "Unknown":
                        title = line[:80]
                        break

                summary = content[:200].replace("\n", " ").strip()

                alert_msg = (
                    f"*Staff Escalation — {dept}*\n\n"
                    f"{title}\n\n"
                    f"{summary}{'...' if len(content) > 200 else ''}\n\n"
                    f"File: `shared/{dept}/escalations/{esc_file.name}`"
                )
                send_telegram_alert(alert_msg)
                log(f"Escalation alert sent: {dept}/{esc_file.name}")

            except Exception as e:
                log(f"Error reading escalation {esc_file}: {e}")

            seen.add(file_key)
            new_found = True

    if new_found:
        save_seen_escalations(seen)


def main() -> None:
    global health_check_attempt, QUALITY_CHECK_TOKEN, QUALITY_CHECK_PROMPT, QUALITY_CHECK_PROMPT_SHA
    log("Atlas Host-Executor starting")
    log(f"  Watching: {PENDING_DIR}")
    log(f"  Output:   {COMPLETED_DIR}")
    log(f"  Escalations: {SHARED_DIR}/*/escalations/")
    log(f"  Timeout:  {TASK_TIMEOUT}s per task")

    # Quality-check token: load best-effort. Unlike the mission-control auth
    # gate (which guards an exposed dashboard), this token only guards the
    # /quality-check endpoint — an optional governance feature. The rest of
    # host-executor (task processing, escalations, auto-push) does not depend
    # on it. So we DON'T fail-closed at startup; instead, the endpoint itself
    # returns 401 for every request when the token is empty.
    QUALITY_CHECK_TOKEN = _load_quality_check_token()
    if QUALITY_CHECK_TOKEN:
        log(f"  Quality check auth: enabled (token len={len(QUALITY_CHECK_TOKEN)})")
    else:
        log("  Quality check auth: DEGRADED — QUALITY_CHECK_TOKEN missing from ~/.atlas/.env")
        log("  Endpoint will 401 every request until token is set. Generate one with:")
        log("    openssl rand -hex 32")
        log("  and add it to ~/.atlas/.env as QUALITY_CHECK_TOKEN=<value>, then restart.")

    # Quality-check prompt: fail-fast if missing. The prompt IS governance
    # contract — running with a missing/silent-fallback prompt would be a
    # second long-lived silent bypass mode (codex consult 2026-04-25 R5).
    # Refuse to start until the file is present in the repo.
    try:
        QUALITY_CHECK_PROMPT = QUALITY_CHECK_PROMPT_PATH.read_text()
    except (FileNotFoundError, PermissionError, OSError) as e:
        log(f"FATAL: Quality-check prompt not loadable from {QUALITY_CHECK_PROMPT_PATH}: {e}")
        log("Refusing to start. Restore the prompt file in the repo and redeploy.")
        log("File path is computed from NANOCLAW_DIR. Check that env var or default ~/nanoclaw is correct.")
        sys.exit(1)
    if not QUALITY_CHECK_PROMPT.strip():
        log(f"FATAL: Quality-check prompt at {QUALITY_CHECK_PROMPT_PATH} is empty.")
        log("Refusing to start. Restore content and redeploy.")
        sys.exit(1)
    if "{RESPONSE}" not in QUALITY_CHECK_PROMPT:
        log(f"FATAL: Quality-check prompt at {QUALITY_CHECK_PROMPT_PATH} missing {{RESPONSE}} placeholder.")
        log("Refusing to start. Without the placeholder the response text is never injected.")
        sys.exit(1)
    QUALITY_CHECK_PROMPT_SHA = hashlib.sha256(QUALITY_CHECK_PROMPT.encode("utf-8")).hexdigest()[:12]
    log(f"  Quality check prompt: loaded ({len(QUALITY_CHECK_PROMPT)} chars, sha={QUALITY_CHECK_PROMPT_SHA})")

    # Start quality check HTTP server. Bind failure is FATAL — the service
    # cannot do its job and silently continuing degraded was an existing bug
    # (host-executor.py:969-973 prior shape: WARNING + continue forever).
    try:
        start_quality_check_server()
    except Exception as e:
        log(f"FATAL: Quality check server failed to start: {e}")
        log("Refusing to start. Resolve the bind issue (likely port conflict on "
            f"{QUALITY_CHECK_PORT}) and redeploy.")
        sys.exit(1)

    # Ensure directories exist
    for d in [PENDING_DIR, COMPLETED_DIR, OUTPUTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    # Seed seen escalations with existing files (don't alert on old ones at startup)
    seen = load_seen_escalations()
    if not seen and SHARED_DIR.exists():
        for esc_file in SHARED_DIR.glob("*/escalations/*.md"):
            seen.add(str(esc_file))
        if seen:
            save_seen_escalations(seen)
            log(f"Seeded {len(seen)} existing escalation(s) as seen")

    poll_count = 0
    last_health_check = 0.0

    while True:
        try:
            # --- Outage mode: health check with backoff, skip task processing ---
            if outage_mode:
                backoff_delay = HEALTH_CHECK_BACKOFF[
                    min(health_check_attempt, len(HEALTH_CHECK_BACKOFF) - 1)
                ]
                if time.time() - last_health_check >= backoff_delay:
                    last_health_check = time.time()
                    if is_api_healthy():
                        exit_outage_mode()
                        # Fall through to process pending tasks immediately
                    else:
                        health_check_attempt += 1
                        log(f"API still down — next health check in {backoff_delay}s "
                            f"(attempt {health_check_attempt})")
                        time.sleep(POLL_INTERVAL)
                        continue
                else:
                    time.sleep(POLL_INTERVAL)
                    continue

            # --- Normal mode: process pending tasks ---
            pending = sorted(PENDING_DIR.glob("*.json"))

            for task_path in pending:
                # If a task triggered outage mode, stop processing remaining tasks
                if outage_mode:
                    break
                process_task(task_path)

            # Check escalations every 6th poll (~30 seconds)
            poll_count += 1
            if poll_count % 6 == 0:
                check_escalations()

        except Exception as e:
            log(f"Poll error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
