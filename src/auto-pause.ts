/**
 * Auto-Pause — Safety system for autonomous task execution.
 *
 * Tracks consecutive failures per group, detects scope expansion,
 * and triggers automatic pause with CEO escalation via Telegram.
 *
 * Session 3c items: 3c-4 (scope expansion detection), 3c-5 (re-evaluation),
 * 3c-6 (auto-pause on uncertainty).
 */

import fs from 'fs';
import path from 'path';

import { ATLAS_STATE_DIR, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { TaskScope } from './task-planner.js';

/** Max consecutive failures before auto-pause triggers */
const MAX_CONSECUTIVE_FAILURES = 3;

/** State file for tracking failure counts and pause state */
const PAUSE_STATE_FILE = path.join(DATA_DIR, 'auto-pause-state.json');

interface PauseState {
  /** Consecutive failure count per group folder */
  failureCounts: Record<string, number>;
  /** Groups that are currently paused */
  pausedGroups: Record<
    string,
    {
      reason: string;
      pausedAt: string;
      failureCount: number;
    }
  >;
  /** Last scope expansion detection per group */
  scopeExpansions: Record<
    string,
    {
      taskId: string;
      declaredPaths: string[];
      expandedPaths: string[];
      detectedAt: string;
    }
  >;
}

function loadPauseState(): PauseState {
  try {
    if (fs.existsSync(PAUSE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(PAUSE_STATE_FILE, 'utf-8'));
    }
  } catch {
    // Corrupt file — start fresh
  }
  return { failureCounts: {}, pausedGroups: {}, scopeExpansions: {} };
}

function savePauseState(state: PauseState): void {
  try {
    fs.mkdirSync(path.dirname(PAUSE_STATE_FILE), { recursive: true });
    fs.writeFileSync(PAUSE_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    logger.warn({ err }, 'Failed to save auto-pause state');
  }
}

/**
 * Record a task result and check if auto-pause should trigger.
 *
 * Returns true if the group should be paused (consecutive failures hit threshold).
 */
export function recordTaskResult(
  groupFolder: string,
  success: boolean,
): { shouldPause: boolean; failureCount: number; reason?: string } {
  const state = loadPauseState();

  if (success) {
    // Reset failure counter on success
    state.failureCounts[groupFolder] = 0;
    savePauseState(state);
    return { shouldPause: false, failureCount: 0 };
  }

  // Increment failure counter
  const count = (state.failureCounts[groupFolder] || 0) + 1;
  state.failureCounts[groupFolder] = count;

  if (count >= MAX_CONSECUTIVE_FAILURES) {
    // Trigger auto-pause
    state.pausedGroups[groupFolder] = {
      reason: `${count} consecutive task failures`,
      pausedAt: new Date().toISOString(),
      failureCount: count,
    };
    savePauseState(state);

    logger.error(
      { groupFolder, failureCount: count },
      'AUTO-PAUSE: Consecutive failure threshold reached',
    );

    return {
      shouldPause: true,
      failureCount: count,
      reason: `${count} consecutive failures — auto-paused to prevent cascading issues`,
    };
  }

  savePauseState(state);
  return { shouldPause: false, failureCount: count };
}

/**
 * Check if a group is currently paused.
 */
export function isGroupPaused(groupFolder: string): {
  paused: boolean;
  reason?: string;
} {
  const state = loadPauseState();
  const pauseInfo = state.pausedGroups[groupFolder];
  if (pauseInfo) {
    return { paused: true, reason: pauseInfo.reason };
  }
  return { paused: false };
}

/**
 * Resume a paused group (CEO command).
 */
export function resumeGroup(groupFolder: string): boolean {
  const state = loadPauseState();
  if (state.pausedGroups[groupFolder]) {
    delete state.pausedGroups[groupFolder];
    state.failureCounts[groupFolder] = 0;
    savePauseState(state);
    logger.info({ groupFolder }, 'Group resumed by command');
    return true;
  }
  return false;
}

/**
 * 3c-4: Detect scope expansion — check if a completed task touched files
 * outside its declared scope.
 *
 * Reads the container log to detect file writes beyond the declared scope.
 * Returns expansion info or null if within scope.
 */
export function detectScopeExpansion(
  scope: TaskScope,
  containerLogPath: string,
): string | null {
  try {
    if (!fs.existsSync(containerLogPath)) return null;

    const log = fs.readFileSync(containerLogPath, 'utf-8');

    // Extract file paths from tool calls in the log (Edit/Write operations)
    const editedFiles = new Set<string>();
    const filePathPattern = /"file_path"\s*:\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = filePathPattern.exec(log)) !== null) {
      editedFiles.add(match[1].toLowerCase().replace(/\\/g, '/'));
    }

    if (editedFiles.size === 0) return null;

    // Check each edited file against declared scope
    const outOfScope: string[] = [];
    for (const file of editedFiles) {
      const inScope = scope.writePaths.some((wp) =>
        file.startsWith(wp.toLowerCase()),
      );
      if (!inScope) {
        outOfScope.push(file);
      }
    }

    if (outOfScope.length === 0) return null;

    // Record expansion
    const state = loadPauseState();
    state.scopeExpansions[scope.groupFolder] = {
      taskId: scope.taskId,
      declaredPaths: scope.writePaths,
      expandedPaths: outOfScope,
      detectedAt: new Date().toISOString(),
    };
    savePauseState(state);

    const msg =
      `SCOPE EXPANSION: Task ${scope.taskId} in ${scope.groupFolder} touched files outside declared scope:\n` +
      outOfScope.map((f) => `  - ${f}`).join('\n');

    logger.warn({ scope, outOfScope }, msg);
    return msg;
  } catch (err) {
    logger.warn({ err }, 'Scope expansion detection failed');
    return null;
  }
}

/**
 * Build a CEO escalation message for auto-pause events.
 */
export function buildEscalationMessage(
  groupFolder: string,
  reason: string,
): string {
  return (
    `⚠️ AUTO-PAUSE: ${groupFolder}\n` +
    `Reason: ${reason}\n` +
    `Time: ${new Date().toISOString()}\n\n` +
    `To resume: /resume ${groupFolder}`
  );
}

/**
 * Get summary of all paused groups and recent failure counts.
 */
export function getPauseStatus(): {
  pausedGroups: Record<string, { reason: string; pausedAt: string }>;
  failureCounts: Record<string, number>;
} {
  const state = loadPauseState();
  return {
    pausedGroups: state.pausedGroups,
    failureCounts: Object.fromEntries(
      Object.entries(state.failureCounts).filter(([, v]) => v > 0),
    ),
  };
}
