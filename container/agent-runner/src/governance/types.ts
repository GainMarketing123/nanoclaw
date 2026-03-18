/**
 * Shared types for the Atlas governance module.
 */

export interface AuditEvent {
  timestamp: string;
  event_id: string;
  actor: {
    type: 'agent' | 'scheduled_task' | 'ceo';
    id: string;
    entity: string;
  };
  action: {
    type: string;
    tool_name: string;
    target?: string;
    authority_tier: number;
    description?: string;
  };
  outcome: {
    status: 'success' | 'denied' | 'error';
    error_message?: string;
    duration_ms?: number;
  };
}

export interface QuotaEntry {
  timestamp: string;
  type: 'autonomous' | 'ceo_session';
  task_id?: string;
  model: string;
  entity: string;
  duration_ms: number;
}

export interface QuotaStatus {
  today_total: number;
  today_autonomous: number;
  today_ceo: number;
  weighted_usage: number;
  throttle_level: 'normal' | 'throttled' | 'paused';
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

export interface PostTaskParams {
  taskId: string;
  entity: string;
  tier: number;
  model: string;
  success: boolean;
  durationMs: number;
  toolCallCount: number;
  errorMessage?: string;
}

export interface GovernanceContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  // Atlas governance extensions
  tier?: number;
  model?: string;
  taskId?: string;
}
