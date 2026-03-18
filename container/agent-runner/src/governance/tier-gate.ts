/**
 * Tier-based tool restriction.
 * Mechanically restricts allowedTools based on the task's authority tier.
 * This is HARD enforcement — not CLAUDE.md instructions.
 */

// Base tools available at every tier (read-only)
const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'ToolSearch',
];

// Tools for interactive use (agent teams, tasks)
const INTERACTIVE_TOOLS = [
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
];

// Full tool set (all container-safe tools)
const ALL_CONTAINER_TOOLS = [
  ...READ_ONLY_TOOLS,
  'Bash', 'Write', 'Edit',
  'TodoWrite', 'Skill', 'NotebookEdit',
  ...INTERACTIVE_TOOLS,
];

/**
 * Tier definitions:
 *   Tier 1: Read-only monitoring. Can observe, cannot modify.
 *   Tier 2: Act then notify. Can read + write + execute.
 *   Tier 3: Draft and queue. Can read + write to approval queue.
 *   Tier 4: CEO only — never runs autonomously.
 */
const TIER_TOOLS: Record<number, string[]> = {
  1: [
    ...READ_ONLY_TOOLS,
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__send_message',  // Can send digest/alerts to CEO
    'mcp__nanoclaw__send_document', // Can send file attachments to CEO
  ],
  2: [
    ...ALL_CONTAINER_TOOLS,
    'mcp__nanoclaw__*',  // Full MCP access
  ],
  3: [
    ...READ_ONLY_TOOLS,
    'Write',  // For writing to approval queue
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__send_document',
    'mcp__nanoclaw__list_tasks',
  ],
  4: [],  // CEO only — never runs autonomously
};

/**
 * Get the allowed tools for a given authority tier.
 * Returns the tool list to pass to the Agent SDK.
 */
export function getAllowedToolsForTier(tier: number): string[] {
  const tools = TIER_TOOLS[tier];
  if (!tools) {
    // Unknown tier — default to most restrictive (Tier 1)
    console.error(`[governance/tier-gate] Unknown tier ${tier}, defaulting to Tier 1`);
    return TIER_TOOLS[1];
  }
  return [...tools];
}

/**
 * Get the default tools (no tier restriction — CEO interactive session).
 * Used when no tier is specified (direct CEO Telegram message).
 */
export function getDefaultTools(): string[] {
  return [
    ...ALL_CONTAINER_TOOLS,
    'mcp__nanoclaw__*',
  ];
}

/**
 * Check if a tier is valid for autonomous execution.
 * Tier 4 is CEO-only and should never be scheduled.
 */
export function isAutonomousTier(tier: number): boolean {
  return tier >= 1 && tier <= 3;
}
