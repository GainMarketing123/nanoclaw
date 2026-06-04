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
 * Wall-clock ms when this module loaded (≈ process start). Used to bound the
 * "still booting" window so a startup wedge before the first heartbeat does not
 * report healthy forever (see getHealthSnapshot's startup-grace branch).
 */
let processStartedAt = Date.now();

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
  /** ms elapsed since process start. */
  uptimeMs: number;
  /** Human-readable reason when unhealthy; undefined when healthy. */
  reason?: string;
}

/**
 * Compute the current liveness verdict.
 *
 * Healthy when:
 *   - the loop has not started yet AND the process is still inside the startup
 *     grace window (a normal cold start: channel auth + DB open), OR
 *   - the loop has beaten within `stallThresholdMs`.
 *
 * Unhealthy when:
 *   - the loop never started AND the startup grace window has elapsed — i.e. a
 *     startup wedge (e.g. a hung `channel.connect()`); the process is up so
 *     `pgrep` passes, but it never reached the work loop. Without this bound
 *     /health would report healthy forever, defeating the watchdog for the
 *     exact internal-stall class it exists to catch. OR
 *   - the loop started and the last heartbeat is older than the threshold —
 *     i.e. the work loop is wedged.
 *
 * @param stallThresholdMs how stale the heartbeat may get before we call it
 *   wedged. Should be comfortably larger than POLL_INTERVAL plus the longest
 *   expected in-loop await, so a normal busy iteration never trips it.
 * @param startupGraceMs how long the process may sit pre-first-heartbeat before
 *   a never-started loop is reported unhealthy. Should cover a normal cold start.
 */
export function getHealthSnapshot(
  stallThresholdMs: number,
  startupGraceMs: number,
  now: number = Date.now(),
): HealthSnapshot {
  const sinceLastBeatMs = lastLoopBeat === 0 ? 0 : now - lastLoopBeat;
  const uptimeMs = now - processStartedAt;

  // Booting: loop hasn't run yet.
  if (!loopStarted) {
    const startupWedged = uptimeMs > startupGraceMs;
    return {
      healthy: !startupWedged,
      loopStarted: false,
      lastLoopBeat,
      sinceLastBeatMs,
      loopIterations,
      stallThresholdMs,
      uptimeMs,
      reason: startupWedged
        ? `startup wedged: message loop has not started ${uptimeMs}ms after process start (grace ${startupGraceMs}ms)`
        : undefined,
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
    uptimeMs,
    reason: stalled
      ? `message loop stalled: no heartbeat for ${sinceLastBeatMs}ms (threshold ${stallThresholdMs}ms)`
      : undefined,
  };
}

/**
 * Reset module state. Test-only.
 *
 * @param startedAt optional override for the process-start baseline so tests can
 *   exercise the startup-grace branch deterministically (defaults to now).
 */
export function _resetHealthState(startedAt: number = Date.now()): void {
  lastLoopBeat = 0;
  loopIterations = 0;
  loopStarted = false;
  processStartedAt = startedAt;
}
