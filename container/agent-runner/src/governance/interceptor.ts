/**
 * SDK event interception for tool call audit logging.
 * Inspects messages from the Agent SDK stream and logs tool_use events.
 */

import { logAuditEvent, createToolCallEvent } from './audit.js';

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AssistantMessage {
  type: 'assistant';
  message?: {
    content?: ContentBlock[];
  };
}

/**
 * Create an interceptor that logs tool calls from SDK messages.
 * Call interceptMessage() for each message in the SDK stream.
 */
export function createAuditInterceptor(entity: string, tier: number, actorId: string) {
  let toolCallCount = 0;

  return {
    /**
     * Inspect a message from the SDK stream. If it contains tool_use blocks,
     * log each one to the audit trail.
     */
    interceptMessage(message: { type: string; message?: { content?: ContentBlock[] } }): void {
      if (message.type !== 'assistant') return;

      const assistant = message as AssistantMessage;
      const content = assistant.message?.content;
      if (!content || !Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          toolCallCount++;
          const toolBlock = block as ToolUseBlock;

          // Extract target from common input patterns
          let target: string | undefined;
          if (toolBlock.input) {
            target = (toolBlock.input.file_path as string)
              || (toolBlock.input.path as string)
              || (toolBlock.input.command as string)?.slice(0, 200)
              || (toolBlock.input.pattern as string)
              || (toolBlock.input.url as string)
              || (toolBlock.input.query as string)
              || undefined;
          }

          logAuditEvent(createToolCallEvent({
            entity,
            actorId,
            actorType: 'agent',
            tier,
            toolName: toolBlock.name,
            target,
            status: 'success',
          }));
        }
      }
    },

    /** Get the total tool call count for this session. */
    getToolCallCount(): number {
      return toolCallCount;
    },
  };
}
