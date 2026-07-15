import { detectIntent } from './intent.js';
import { buildContext } from './context.js';
import { createTask, completeTask, addMessage } from '../memory/repositories/tasks.js';
import { CoderAgent } from '../agents/coder-agent.js';
import { ReviewerAgent } from '../agents/reviewer-agent.js';
import { ResearchAgent } from '../agents/research-agent.js';
import { WriterAgent } from '../agents/writer-agent.js';
import { GeneralAgent } from '../agents/general-agent.js';
import { notify } from '../n8n/n8n-client.js';
import { logger } from '../utils/logger.js';
import type { AgentName, AgentContext, AgentResponse } from '../types.js';

type BaseAgent = {
  run(ctx: AgentContext): Promise<AgentResponse>;
};

function makeAgent(name: AgentName): BaseAgent {
  switch (name) {
    case 'coder':      return new CoderAgent();
    case 'reviewer':   return new ReviewerAgent();
    case 'researcher': return new ResearchAgent();
    case 'writer':     return new WriterAgent();
    default:           return new GeneralAgent();
  }
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
  tokensUsed?: number;
}

export async function run(input: OrchestratorInput): Promise<OrchestratorResult> {
  const { userMessage, sessionId, projectId, previousTaskId } = input;

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
    const agentInstance = makeAgent(agent);
    const agentResponse = await agentInstance.run(ctx);

    // 6. Persist assistant response
    addMessage(task.id, 'assistant', agentResponse.content);

    // 7. Mark task complete (validation runs in start.ts after the user accepts diffs)
    completeTask(task.id, agentResponse.content, 'done');

    // 8. Notify N8N (fire-and-forget)
    notify({
      event: 'task.completed',
      payload: { taskId: task.id, intent, agent, success: true },
      timestamp: new Date().toISOString(),
    }).catch(() => { /* N8N is optional */ });

    return {
      taskId: task.id,
      intent,
      agent,
      response: agentResponse.content,
      tokensUsed: agentResponse.tokensUsed,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    addMessage(task.id, 'assistant', message);
    completeTask(task.id, message, 'failed');
    throw err;
  }
}
