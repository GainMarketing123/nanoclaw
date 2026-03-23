/**
 * Task Planner — Parallelization Safety for Concurrent Containers
 *
 * Analyzes queued tasks before execution to determine which can safely
 * run in parallel vs which must be serialized. Based on file-scope overlap
 * detection and shared-state conflict analysis.
 *
 * Session 3c items: 3c-1 (scope declaration), 3c-2 (overlap detection),
 * 3c-3 (parallel vs sequential recommendation).
 */

import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

/**
 * Declared scope for a task — which files/directories it's expected to touch.
 */
export interface TaskScope {
  taskId: string;
  groupFolder: string;
  /** Directories the task will write to (inferred from group + prompt) */
  writePaths: string[];
  /** Shared state files the task may access */
  sharedState: boolean;
  /** Whether the task touches Atlas infra (hooks, config, agents) */
  touchesAtlasInfra: boolean;
}

/**
 * Execution plan — which tasks can parallelize and which must serialize.
 */
export interface ExecutionPlan {
  /** Groups of tasks safe to run in parallel (each group runs concurrently) */
  parallelGroups: TaskScope[][];
  /** Tasks that must run alone (serialize — one at a time) */
  serialized: TaskScope[];
  /** Detected conflicts that forced serialization */
  conflicts: string[];
}

/** Keywords that suggest a task touches Atlas infrastructure */
const ATLAS_INFRA_KEYWORDS = [
  'hook', 'enforcement', 'settings.json', 'constitution',
  'graduation', 'manifest', 'self-knowledge', 'agent-runner',
  'build.sh', 'dockerfile', 'nanoclaw',
];

/** Keywords that suggest shared state access */
const SHARED_STATE_KEYWORDS = [
  'session-status', 'graduation', 'autonomy', 'evolution-log',
  'project-registry', 'entity-map', 'config.json', 'quota',
  'blocker', 'milestone',
];

/**
 * 3c-1: Declare the file-touch scope for a task based on its prompt
 * and group configuration.
 *
 * This is a fast, mechanical analysis (no LLM call). It scans the prompt
 * for known keywords and patterns to predict which files the task will modify.
 */
export function declareScope(task: ScheduledTask): TaskScope {
  const promptLower = task.prompt.toLowerCase();

  // Check for Atlas infra keywords
  const touchesAtlasInfra = ATLAS_INFRA_KEYWORDS.some(
    (kw) => promptLower.includes(kw),
  );

  // Check for shared state keywords
  const sharedState = SHARED_STATE_KEYWORDS.some(
    (kw) => promptLower.includes(kw),
  );

  // Write paths: the group's own workspace is always in scope.
  // Additional paths inferred from prompt content.
  const writePaths = [task.group_folder];

  // If the prompt mentions specific project paths, add them
  const pathMatches = task.prompt.match(
    /(?:\/home\/\w+\/[\w/.-]+|~\/[\w/.-]+|C:\/[\w/ .-]+)/gi,
  );
  if (pathMatches) {
    writePaths.push(...pathMatches.map((p) => p.toLowerCase()));
  }

  return {
    taskId: task.id,
    groupFolder: task.group_folder,
    writePaths,
    sharedState,
    touchesAtlasInfra,
  };
}

/**
 * 3c-2: Detect overlapping file scopes between two tasks.
 * Returns a conflict description or null if no overlap.
 */
export function detectOverlap(a: TaskScope, b: TaskScope): string | null {
  // Same group folder — always conflicts (GroupQueue already serializes these)
  if (a.groupFolder === b.groupFolder) {
    return `Same group: ${a.groupFolder}`;
  }

  // Both touch Atlas infrastructure — serialize to prevent config races
  if (a.touchesAtlasInfra && b.touchesAtlasInfra) {
    return `Both touch Atlas infra: ${a.taskId} and ${b.taskId}`;
  }

  // Both access shared state — serialize to prevent state corruption
  if (a.sharedState && b.sharedState) {
    return `Both access shared state: ${a.taskId} and ${b.taskId}`;
  }

  // Check for overlapping write paths
  for (const pathA of a.writePaths) {
    for (const pathB of b.writePaths) {
      if (
        pathA.startsWith(pathB) ||
        pathB.startsWith(pathA)
      ) {
        return `Overlapping paths: ${pathA} ↔ ${pathB} (${a.taskId} vs ${b.taskId})`;
      }
    }
  }

  return null; // No overlap — safe to parallelize
}

/**
 * 3c-3: Build an execution plan for a batch of tasks.
 * Groups tasks into parallel-safe sets and serialized singles.
 */
export function buildExecutionPlan(tasks: ScheduledTask[]): ExecutionPlan {
  if (tasks.length <= 1) {
    const scopes = tasks.map(declareScope);
    return {
      parallelGroups: scopes.length ? [scopes] : [],
      serialized: [],
      conflicts: [],
    };
  }

  const scopes = tasks.map(declareScope);
  const conflicts: string[] = [];
  const mustSerialize = new Set<string>(); // task IDs that must be serialized

  // Check all pairs for overlaps
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      const overlap = detectOverlap(scopes[i], scopes[j]);
      if (overlap) {
        conflicts.push(overlap);
        mustSerialize.add(scopes[i].taskId);
        mustSerialize.add(scopes[j].taskId);
      }
    }
  }

  const parallelScopes = scopes.filter((s) => !mustSerialize.has(s.taskId));
  const serializedScopes = scopes.filter((s) => mustSerialize.has(s.taskId));

  const plan: ExecutionPlan = {
    parallelGroups: parallelScopes.length > 0 ? [parallelScopes] : [],
    serialized: serializedScopes,
    conflicts,
  };

  if (conflicts.length > 0) {
    logger.info(
      {
        totalTasks: tasks.length,
        parallel: parallelScopes.length,
        serialized: serializedScopes.length,
        conflicts: conflicts.length,
      },
      'Task planner: detected conflicts, serializing overlapping tasks',
    );
  }

  return plan;
}
