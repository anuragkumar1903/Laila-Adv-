import { detectIntent } from './intent.js';
import { buildContext } from './context.js';
import { createTask, completeTask, addMessage } from '../memory/repositories/tasks.js';
import { cleanupStaleSessions } from '../memory/repositories/sessions.js';
import { buildMessages } from '../llm/prompt-builder.js';
import { chat } from '../llm/provider-factory.js';
import { notify } from '../n8n/n8n-client.js';
import { logger } from '../utils/logger.js';
import type { AgentName, AgentContext, AgentResponse } from '../types.js';

import { getNativeTools } from '../tools/native-tools.js';

async function runAgent(name: AgentName, ctx: AgentContext): Promise<AgentResponse> {
  const messages = await buildMessages(ctx);
  // Only coder and reviewer need strict determinism
  const temperature = (name === 'coder' || name === 'reviewer') ? 0.1 : 0.7;
  const tools = getNativeTools();
  const result = await chat(messages, { temperature, tools });
  return { content: result.content, toolCalls: result.toolCalls, tokensUsed: result.tokensUsed };
}

export interface OrchestratorInput {
  userMessage: string;
  sessionId: number;
  projectId: number | null;
  previousTaskId?: number;
}

export interface OrchestratorResult {
  taskId: number;
  intent: string;
  agent: AgentName;
  response: string;
  toolCalls?: import('../llm/providers/base.js').ToolCall[];
  tokensUsed?: number;
}

export async function run(input: OrchestratorInput): Promise<OrchestratorResult> {
  const { userMessage, sessionId, projectId, previousTaskId } = input;

  // Clean up stale sessions from previous crashed/killed processes
  try { cleanupStaleSessions(); } catch (err) {
    logger.debug?.('cleanupStaleSessions failed (non-fatal): ' + String(err));
  }

  // 1. Detect intent
  const { intent, agent } = detectIntent(userMessage);
  logger.debug(`Intent: ${intent}, Agent: ${agent}`);

  // 2. Create task record
  const task = createTask({ sessionId, projectId, intent, agent, input: userMessage });

  // 3. Persist user message
  addMessage(task.id, 'user', userMessage);

  // 4. Build context (project index + relevant files + skill + history)
  const ctx = await buildContext({
    userMessage,
    agent,
    taskId: task.id,
    projectId,
    previousTaskId,
  });

  try {
    // 5. Run agent
    const agentResponse = await runAgent(agent, ctx);

    // 6. Persist assistant response
    addMessage(task.id, 'assistant', agentResponse.content);

    // 7. Mark task complete (validation runs in start.ts after the user accepts diffs)
    completeTask(task.id, agentResponse.content, 'done');

    // 8. Notify N8N (fire-and-forget)
    notify({
      event: 'task.completed',
      payload: { taskId: task.id, intent, agent, success: true },
      timestamp: new Date().toISOString(),
    }).catch(err => logger.debug?.('N8N notify failed: ' + String(err)));

    return {
      taskId: task.id,
      intent,
      agent,
      response: agentResponse.content,
      toolCalls: agentResponse.toolCalls,
      tokensUsed: agentResponse.tokensUsed,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    addMessage(task.id, 'assistant', message);
    completeTask(task.id, message, 'failed');
    throw err;
  }
}
