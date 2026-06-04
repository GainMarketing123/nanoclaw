/**
 * Internal liveness tracking for the orchestrator.
 *
 * The orchestrator is a long-lived Node process whose real work happens in a
 * `while (true)` message poll loop (see startMessageLoop in index.ts). If that
 * loop wedges — stuck awaiting a hung container, a deadlocked DB handle, or an
 * unthrown rejection that stops the iteration — the *process* stays alive, so
 * an external `pgrep` still passes while no messages are being processed. That
 * is exactly the "internal stall" the atlas-watchdog cannot see today.
 *
 * This module records a heartbeat each time the poll loop completes an
 * iteration. The /health HTTP endpoint (health-server.ts) reads the heartbeat
 * and reports unhealthy (HTTP 503) when the loop hasn't beaten within a stall
 * threshold, giving the watchdog a real internal-liveness probe instead of a
 * bare process check.
 */

/** Monotonic-ish wall-clock timestamp (ms) of the last poll-loop iteration. */
let lastLoopBeat = 0;

/** Total poll-loop iterations since process start — useful for diagnostics. */
let loopIterations = 0;

/** Set true once the message loop has started; before that, "starting" is healthy. */
let loopStarted = false;

/**
 * Called once per message-loop iteration. Cheap and allocation-free so it can
 * sit on the hot path without measurable cost.
 */
export function recordLoopBeat(now: number = Date.now()): void {
  lastLoopBeat = now;
  loopIterations += 1;
  loopStarted = true;
}

/** Snapshot of the current liveness state, for the health endpoint. */
export interface HealthSnapshot {
  /** Overall verdict — false means a component looks stalled/wedged. */
  healthy: boolean;
  /** True once the poll loop has produced at least one heartbeat. */
  loopStarted: boolean;
  /** Wall-clock ms of the last poll-loop iteration (0 if never). */
  lastLoopBeat: number;
  /** ms elapsed since the last poll-loop iteration. */
  sinceLastBeatMs: number;
  /** Total poll-loop iterations since start. */
  loopIterations: number;
  /** The stall threshold the verdict was computed against. */
  stallThresholdMs: number;
  /** Human-readable reason when unhealthy; undefined when healthy. */
  reason?: string;
}

/**
 * Compute the current liveness verdict.
 *
 * Healthy when:
 *   - the loop has not started yet (process is still booting — `pgrep` plus
 *     systemd's own startup timeout own that window), OR
 *   - the loop has beaten within `stallThresholdMs`.
 *
 * Unhealthy when the loop started and the last heartbeat is older than the
 * threshold — i.e. the work loop is wedged.
 *
 * @param stallThresholdMs how stale the heartbeat may get before we call it
 *   wedged. Should be comfortably larger than POLL_INTERVAL plus the longest
 *   expected in-loop await, so a normal busy iteration never trips it.
 */
export function getHealthSnapshot(
  stallThresholdMs: number,
  now: number = Date.now(),
): HealthSnapshot {
  const sinceLastBeatMs = lastLoopBeat === 0 ? 0 : now - lastLoopBeat;

  // Booting: loop hasn't run yet. Healthy — startup is owned elsewhere.
  if (!loopStarted) {
    return {
      healthy: true,
      loopStarted: false,
      lastLoopBeat,
      sinceLastBeatMs,
      loopIterations,
      stallThresholdMs,
    };
  }

  const stalled = sinceLastBeatMs > stallThresholdMs;
  return {
    healthy: !stalled,
    loopStarted: true,
    lastLoopBeat,
    sinceLastBeatMs,
    loopIterations,
    stallThresholdMs,
    reason: stalled
      ? `message loop stalled: no heartbeat for ${sinceLastBeatMs}ms (threshold ${stallThresholdMs}ms)`
      : undefined,
  };
}

/** Reset module state. Test-only. */
export function _resetHealthState(): void {
  lastLoopBeat = 0;
  loopIterations = 0;
  loopStarted = false;
}
