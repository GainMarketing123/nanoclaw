"""Shared path resolution for Atlas + Claude install/credential roots.

Three roots, three env vars:
    ATLAS_DIR          — Atlas engineering install (default: ~/.atlas)
    ATLAS_OPS_DIR      — Atlas operations install (default: ~/.atlas-operations)
    CLAUDE_CONFIG_DIR  — Claude credential/config home (default: ~/.claude)

CLAUDE_CONFIG_DIR matches the existing Claude CLI / Anthropic SDK convention.
In this repo, host/host-executor.py is the standalone systemd entrypoint and
uses env_or_home(strict=...) under ATLAS_HOST_MODE=production so production
units fail loudly instead of silently resolving Path.home() to the wrong tree.

When the runtime user differs from the user who owns the install (e.g. the VPS
nanoclaw-he service user introduced in 1.A.6 Phase 3.2), the env var wins so
services find the canonical install at /home/atlas/.atlas regardless of $HOME.

This module exposes module-level constants computed once at import. Bootstrap
callers that load before lib/ is importable (a handful of hook entrypoints)
must use an inline shim with the identical precedence rule — not this module.

Symlinks are preserved literally (no .resolve() / no realpath dereference).

Helper scope is install ROOTS only. Subsystems own their own derived-path
constants (state/, hook-health/, sessions/, etc.) — keep those out of here.

DUPLICATION NOTE: this file is duplicated across four repos to make each
self-contained for standalone imports (closes codex c2cb316 + dfa3ba5
findings — bare `from atlas_paths import` raises ModuleNotFoundError when
the importing repo can't reach atlas-engineering's lib/). Sources of truth
must be kept byte-identical (code lines; docstring intros may vary):
  - atlas-engineering/lib/atlas_paths.py    (canonical)
  - atlas-shared/lib/atlas_paths.py
  - atlas-operations/lib/atlas_paths.py
  - nanoclaw/lib/atlas_paths.py             (this file)
Any change to one MUST be propagated to the other three in the same arc.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path
from typing import Iterable


def env_or_home(env_name: str, leaf: str, strict: bool = False) -> Path:
    """Resolve an Atlas install root from env var or default to ~/<leaf>.

    Default semantics: when env_name is set, return Path(env_name). Otherwise
    return Path.home() / leaf. This matches the historical behavior the three
    module-level constants below have always used and that every existing
    caller relies on.

    strict=True is opt-in for entrypoints that must NOT silently fall back to
    Path.home() when the env var is missing. The classic case is a systemd
    service running as a different POSIX user from the install owner — under
    the wrong User= value, Path.home() resolves cleanly to the wrong tree
    and the service silently operates against unrelated state. Strict mode
    raises RuntimeError instead, so the deployment failure is loud.

    Callers compose strict at call time, e.g.:
        strict = os.environ.get("ATLAS_HOST_MODE") == "production"
        ATLAS_DIR = env_or_home("ATLAS_DIR", ".atlas", strict=strict)

    The flag is intentionally generic — it does NOT bake in any specific
    sentinel like ATLAS_HOST_MODE. Callers decide which signal triggers
    strict. (Codex 2026-05-08 design constraint on the host-executor dedup.)
    """
    value = os.environ.get(env_name)
    if value:
        return Path(value)
    if strict:
        raise RuntimeError(
            f"{env_name} must be set when strict mode is enabled. "
            f"This typically means a systemd unit's User= differs from the "
            f"install owner, so Path.home() would resolve to the wrong tree. "
            f"Add {env_name}=<absolute-path> to the unit's EnvironmentFile= "
            f"or remove the strict-mode signal for dev/laptop runs."
        )
    return Path.home() / leaf


ATLAS_DIR: Path = env_or_home("ATLAS_DIR", ".atlas")
ATLAS_OPS_DIR: Path = env_or_home("ATLAS_OPS_DIR", ".atlas-operations")
CLAUDE_CONFIG_DIR: Path = env_or_home("CLAUDE_CONFIG_DIR", ".claude")


def _extract_module_symbols(module_path: Path) -> "frozenset[str] | None":
    """Return all top-level names bound in a Python source file (AST, no import).

    Handles: def/async def/class, assignments (=, +=), annotated assignments,
    top-level `import X` and `from X import Y` re-exports.

    Returns None on any parse or read error (fail-open SENTINEL — callers
    treat None as "inconclusive, skip symbol validation"). Returning
    frozenset() instead would silently fail-closed: any required symbol
    would be missing and the candidate would be rejected, which is the
    opposite of the documented "best-effort" intent. Codex 6a4b64a F2
    BLOCKING fix.
    """
    try:
        source = module_path.read_text(encoding="utf-8", errors="replace")
        tree = ast.parse(source, filename=str(module_path))
    except (SyntaxError, OSError, ValueError):
        return None
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
                elif isinstance(target, ast.Tuple):
                    for elt in target.elts:
                        if isinstance(elt, ast.Name):
                            names.add(elt.id)
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
        elif isinstance(node, ast.AugAssign):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname if alias.asname else alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name != "*":
                    names.add(alias.asname if alias.asname else alias.name)
    return frozenset(names)


def _path_satisfies(
    lib_path: Path,
    required_modules: Iterable[str],
    required_symbols: "dict[str, list[str]] | None" = None,
) -> bool:
    """True iff lib_path contains every required module AND exports required symbols.

    Supports two module declaration shapes:
      - "name.py"  — must be a regular file at lib_path/name.py
      - "name"     — must be a package directory at lib_path/name/ with
                     an __init__.py inside

    required_symbols (optional): dict mapping module-name (no .py suffix) to
    symbol names that must appear as top-level bindings in that module. Checked
    via _extract_module_symbols (AST, no import side effects). A candidate
    fails if any listed symbol is absent from the module's top-level namespace.
    """
    if not lib_path.is_dir():
        return False
    for m in required_modules:
        if "/" in m or m.endswith(".py"):
            if not (lib_path / m).is_file():
                return False
        else:
            pkg = lib_path / m
            if not (pkg.is_dir() and (pkg / "__init__.py").is_file()):
                return False
    if required_symbols:
        for module_name, symbols in required_symbols.items():
            # Resolve BOTH module shapes: package directory (name/__init__.py)
            # OR plain file (name.py). Package-FIRST matches Python import
            # semantics — CPython's FileFinder probes regular packages before
            # plain module files, so `import foo` against a lib/ that contains
            # both `foo/__init__.py` and `foo.py` loads the package. Validating
            # the symbol manifest against the same file Python will actually
            # import prevents a false-positive "manifest passed" against the
            # plain file while runtime imports a package with a different API.
            # Codex 6a4b64a F1 BLOCKING fix (initial both-shapes support).
            # Task #11 design ratification 2026-05-18: order flipped to
            # package-first to close the latent import-vs-validate mismatch.
            pkg_init = lib_path / module_name / "__init__.py"
            if pkg_init.is_file():
                module_file = pkg_init
            else:
                module_file = lib_path / f"{module_name}.py"
                if not module_file.is_file():
                    return False
            exported = _extract_module_symbols(module_file)
            if exported is None:
                # Parse/read failed — fail-OPEN per the docstring's
                # "best-effort" contract. Skip symbol validation for this
                # module; presence check already passed.
                continue
            for sym in symbols:
                if sym not in exported:
                    return False
    return True


def resolve_lib_path_for(
    required_modules: Iterable[str],
    source_fallback: "Path | str | None" = None,
    required_symbols: "dict[str, list[str]] | None" = None,
) -> Path:
    """Return a lib/ Path validated to contain every required module and symbol.

    Resolution order:
      1. ATLAS_DIR env override + lib/, if every required module is present
         and every required symbol is exported by its module
      2. Caller-provided source_fallback (the in-flight checkout's lib),
         if every required module is present (and symbols)
      3. Sibling lib/ of this file (where atlas_paths was loaded from),
         if every required module is present (and symbols)
      4. ~/.atlas/lib (default home install), if every required module is
         present (and symbols)

    Each entrypoint declares the FULL set of files (.py modules, or
    package directories with __init__.py) it will import after this
    call. Silent fallback to a partial tree is impossible — the call
    raises FileNotFoundError if no candidate satisfies the contract.

    Codex 8dee0bc F1 BLOCKING fix: pass source_fallback explicitly.
    Without it, Path(__file__).resolve().parent of atlas_paths equals
    the path the inline-probe found atlas_paths at. If the inline
    probe found atlas_paths in a partial-tree override (override has
    atlas_paths.py + hook_io.py but not the broader contract),
    candidate 3 in the original order duplicated candidate 1 — the
    resolver fell through to ~/.atlas/lib (host install), bypassing
    the in-flight checkout entirely. With source_fallback the caller
    passes its own source-tree sibling explicitly so candidate 2
    points at the actual checkout, not at where atlas_paths happened
    to load from.

    Codex 0e0dd1f F1+F2 BLOCKING-named architectural fix: replaces
    the bootstrap-minimum probe (atlas_paths.py + hook_io.py only)
    that each hook entrypoint duplicated, which let downstream
    imports fail silently after bootstrap "succeeded" against a
    partial-tree override.

    Wave 1 Lane C symbol-manifest fix: required_symbols extends the
    presence-only check with an AST-based symbol export verification.
    Mixed-version override deployments where a candidate lib/ has the
    required module files but an older API (missing emit_block,
    emit_pass, etc.) now fall back to the next candidate instead of
    crashing with ImportError after bootstrap "succeeds".

    Hook entrypoint pattern (with symbol manifest):
        # 1. Tiny inline probe — find atlas_paths.py
        _atlas_dir_env = os.environ.get("ATLAS_DIR")
        _atlas_dir = Path(_atlas_dir_env) if _atlas_dir_env else Path.home() / ".atlas"
        _lib = _atlas_dir / "lib"
        if not (_lib / "atlas_paths.py").is_file():
            _lib = Path(__file__).resolve().parent.parent / "lib"
        sys.path.insert(0, str(_lib))
        # 2. Full validation via shared resolver
        from atlas_paths import resolve_lib_path_for
        _HAS_REQUIRED_SYMBOLS = (
            "required_symbols"
            in resolve_lib_path_for.__code__.co_varnames[
                :resolve_lib_path_for.__code__.co_argcount
            ]
        )
        _SYMBOL_MANIFEST = {
            "hook_io": ["emit_block", "emit_pass", ...unconditional imports only...],
        }
        if _HAS_SOURCE_FALLBACK and _HAS_REQUIRED_SYMBOLS:
            _BOOTSTRAP_LIB_PATH = resolve_lib_path_for(
                ("atlas_paths.py", "hook_io.py", ...),
                source_fallback=Path(__file__).resolve().parent.parent / "lib",
                required_symbols=_SYMBOL_MANIFEST,
            )
        elif _HAS_SOURCE_FALLBACK:
            _BOOTSTRAP_LIB_PATH = resolve_lib_path_for(
                ("atlas_paths.py", "hook_io.py", ...),
                source_fallback=Path(__file__).resolve().parent.parent / "lib",
            )
        else:
            _BOOTSTRAP_LIB_PATH = resolve_lib_path_for(
                ("atlas_paths.py", "hook_io.py", ...),
            )

    Required-module tuple guidance: include ONLY modules imported
    unconditionally before main() (top-level imports). Lazy / fail-
    open imports (try/except wrapped, or inside conditional branches)
    must be left out — making them required would convert a fail-open
    hook into a hard startup failure when the optional module is
    missing. Same rule applies to required_symbols entries.

    Args:
        required_modules: iterable of file/package names relative to
            the target lib/ directory. Use "name.py" for plain module
            files, "name" for package directories with __init__.py.
        source_fallback: optional path to the caller's source-tree
            sibling lib/. When provided, this is candidate 2 in the
            resolution order — preferred over atlas_paths' sibling
            (candidate 3) because the caller knows its own checkout
            location while atlas_paths only knows where it loaded from.
        required_symbols: optional dict mapping module-name (no .py
            suffix) to the list of symbol names that must be top-level
            bindings in that module. Checked via AST — no import side
            effects. A candidate lib/ path fails if any listed symbol
            is absent from the module's top-level namespace. Use for
            modules where the exact API surface matters across versions
            (e.g. emit_block/emit_pass/emit_allow_with_context in
            hook_io). Default None preserves pre-Wave-1 behavior.

    Returns:
        Path to the lib/ that satisfies the contract.

    Raises:
        ValueError if required_modules is empty.
        FileNotFoundError if no candidate path satisfies the contract.
    """
    required = tuple(required_modules)
    if not required:
        raise ValueError("required_modules must be non-empty")

    candidates = []
    env_dir = os.environ.get("ATLAS_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "lib")
    if source_fallback is not None:
        candidates.append(Path(source_fallback))
    candidates.append(Path(__file__).resolve().parent)
    candidates.append(Path.home() / ".atlas" / "lib")

    seen = set()
    deduped = []
    for c in candidates:
        cs = str(c)
        if cs in seen:
            continue
        seen.add(cs)
        deduped.append(c)

    for cand in deduped:
        if _path_satisfies(cand, required, required_symbols):
            return cand

    raise FileNotFoundError(
        f"No lib/ path satisfies required modules {required}"
        + (f" with symbols {required_symbols}" if required_symbols else "")
        + f". Tried: {[str(c) for c in deduped]}"
    )


__all__ = [
    "ATLAS_DIR",
    "ATLAS_OPS_DIR",
    "CLAUDE_CONFIG_DIR",
    "env_or_home",
    "resolve_lib_path_for",
]
