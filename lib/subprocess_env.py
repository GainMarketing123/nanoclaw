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

The helper returns a fresh dict every call; it does NOT mutate os.environ.
"""
from __future__ import annotations

import os


def claude_subprocess_env(extra_env: dict | None = None) -> dict:
    """Build a child-process env for `claude -p` that forces OAuth subscription.

    Strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from a copy of
    os.environ so the spawned claude -p falls through to the OAuth Max
    subscription path instead of using the metered API key.

    Args:
        extra_env: optional additional env vars merged AFTER the strip
            (so callers can layer in their own vars without re-introducing
            the stripped keys).

    Returns:
        A new dict suitable for subprocess.run/Popen `env=` argument.
        The returned dict is a fresh copy; mutating it does NOT affect
        os.environ.

    Both env-var names are stripped because ANTHROPIC_AUTH_TOKEN is the
    alternate name some Claude Code versions read; stripping both is
    belt-and-suspenders against future SDK changes.
    """
    # Codex d464a35 SOFT fix (2026-05-13): strip AFTER merging extra_env.
    # The prior strip-before-merge order let a caller passing
    # `extra_env={"ANTHROPIC_API_KEY": ...}` re-introduce the exact key
    # this helper exists to prevent. Strip-last makes the helper's
    # contract structural: the returned dict NEVER contains the
    # Anthropic key env vars, regardless of extra_env content.
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env
