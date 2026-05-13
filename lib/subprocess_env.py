"""Subprocess environment helpers for Claude Code spawns.

Single source of truth for the "strip ANTHROPIC_API_KEY before claude -p"
pattern. Every spawn site that runs `claude -p` (subprocess.run, Popen,
create_subprocess_exec) MUST pass `env=claude_subprocess_env()` instead
of `env={**os.environ, ...}` — otherwise the inherited ANTHROPIC_API_KEY
will silently bill the metered API key on every supposedly-free OAuth
subscription call.

Background
----------
claude -p prefers ANTHROPIC_API_KEY in env over OAuth subscription and
does NOT fall back to OAuth on API-key 401 — it just errors. Atlas hooks
that inherited the key from ~/.atlas/.env (loaded for unrelated reasons
like Telegram tokens, Perplexity, Brave) silently billed every Stop-hook
grading call to the metered API key. $76 burn over 2 months before the
2026-05-12 diagnosis.

Full diagnosis lives in Atlas memory under
`feedback_claude_p_anthropic_api_key_leak`. The melbourne lane (2026-05-13)
found another previously-undocumented spawn site in nanoclaw's
host-executor.py:process_task that the original audit missed — exactly
the class-miss this helper exists to prevent.

Usage
-----
    from subprocess_env import claude_subprocess_env
    subprocess.run(["claude", "-p", "..."], env=claude_subprocess_env())

To layer extra env vars on top of the stripped base, pass `extra_env`:
    env=claude_subprocess_env(extra_env={"FOO": "bar"})

For documented custom-endpoint mode (ANTHROPIC_BASE_URL +
ANTHROPIC_AUTH_TOKEN, e.g. nanoclaw third-party-backend mode per
nanoclaw README:189-203), pass `strip_auth_token=False` to preserve
the auth token in the child env:
    env=claude_subprocess_env(strip_auth_token=False)

The helper returns a fresh dict every call; it does NOT mutate os.environ.

Contract
--------
- `ANTHROPIC_API_KEY` is ALWAYS removed from the returned env. This is
  the spend-risk invariant — the metered-billing key must never reach
  `claude -p`. No flag, no `extra_env` value, and no caller can keep
  it in the child env.
- `ANTHROPIC_AUTH_TOKEN` is removed by default (`strip_auth_token=True`).
  Callers using documented custom-endpoint mode opt out via
  `strip_auth_token=False`; in that case a caller-provided value
  (whether inherited from `os.environ` or supplied via `extra_env`)
  survives into the child env.
"""
from __future__ import annotations

import os


def claude_subprocess_env(
    extra_env: dict | None = None,
    *,
    strip_auth_token: bool = True,
) -> dict:
    """Build a child-process env for `claude -p` that forces OAuth subscription.

    Strips ANTHROPIC_API_KEY (always) and, by default, ANTHROPIC_AUTH_TOKEN
    from a copy of os.environ so the spawned claude -p falls through to
    the OAuth Max subscription path instead of using the metered API key.

    Args:
        extra_env: optional additional env vars merged AFTER os.environ
            (so callers can layer in their own vars). The two Anthropic
            credential keys are stripped AFTER this merge — so passing
            `extra_env={"ANTHROPIC_API_KEY": ...}` does NOT re-introduce
            the API key (always-stripped contract). Passing
            `extra_env={"ANTHROPIC_AUTH_TOKEN": ...}` with
            `strip_auth_token=True` (default) also does not survive.
            Passing `extra_env={"ANTHROPIC_AUTH_TOKEN": ...}` with
            `strip_auth_token=False` DOES survive — that's the
            custom-endpoint opt-in path.
        strip_auth_token: when True (default), pops ANTHROPIC_AUTH_TOKEN
            from the child env in addition to ANTHROPIC_API_KEY. Set False
            for callers using ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
            custom-endpoint mode (e.g. nanoclaw host-executor when
            configured for a Claude-compatible third-party backend per
            nanoclaw README:189-203). Keyword-only so call sites stay
            self-documenting and the default-callers' API surface is
            unchanged.

    Returns:
        A new dict suitable for subprocess.run/Popen `env=` argument.
        The returned dict is a fresh copy; mutating it does NOT affect
        os.environ.

    Contract:
        - ANTHROPIC_API_KEY is ALWAYS absent from the returned dict.
          This is the spend-risk invariant — there is no flag or caller
          path that keeps it in the child env.
        - ANTHROPIC_AUTH_TOKEN is absent by default; present only when
          `strip_auth_token=False` AND a value is in os.environ or
          extra_env at call time.
    """
    # Codex d464a35 SOFT fix (2026-05-13): strip AFTER merging extra_env.
    # The prior strip-before-merge order let a caller passing
    # `extra_env={"ANTHROPIC_API_KEY": ...}` re-introduce the exact key
    # this helper exists to prevent. Strip-last makes the API-key strip
    # structural: the returned dict NEVER contains ANTHROPIC_API_KEY,
    # regardless of extra_env content.
    #
    # Tokyo v2 (2026-05-13): strip_auth_token flag added for nanoclaw
    # custom-endpoint mode (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN per
    # nanoclaw README:189-203). The API-key strip remains unconditional;
    # only the AUTH_TOKEN strip is now gated by the flag. Codex consult
    # before commit flagged "caller confusion" risk — addressed via the
    # explicit Contract block in this docstring.
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    env.pop("ANTHROPIC_API_KEY", None)
    if strip_auth_token:
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env
