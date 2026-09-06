import { detectIntent } from './intent.js';
import { buildContext } from './context.js';
import { isComplexTask, generatePlan } from './planner.js';
import { createTask, completeTask, addMessage } from '../memory/repositories/tasks.js';
import { cleanupStaleSessions } from '../memory/repositories/sessions.js';
import { buildMessages } from '../llm/prompt-builder.js';
import { chat, streamChat } from '../llm/provider-factory.js';
import { notify } from '../n8n/n8n-client.js';
import { logger } from '../utils/logger.js';
import { printer } from '../cli/ui/printer.js';
import type { AgentName, AgentContext, AgentResponse } from '../types.js';
import type { LLMMessage, ToolCall } from '../llm/providers/base.js';
import { getNativeTools, executeTool } from '../tools/native-tools.js';
import { trackTokens } from '../memory/cost-tracker.js';

// Maximum number of tool-call iterations before we force-stop the loop.
const MAX_TOOL_ITERATIONS = 20;

/**
 * runAgent — the core agentic tool loop.
 *
 * Loop:
 *   1. Build the full message list (system + history + user + accumulated tool messages).
 *   2. Call the LLM.
 *   3. If tool calls → execute each, append as role:'tool' messages → go to 2.
 *   4. No tool calls → stream the final response to terminal → done.
 *
 * Tool results go back to the model as proper tool-role messages (not user text)
 * to keep chain-of-thought intact across multi-step reasoning.
 */
async function runAgent(
  name: AgentName,
  ctx: AgentContext,
  sessionId: number,
  onToken?: (token: string) => void,
  verbose?: boolean,
  mcpTools?: import('../llm/providers/base.js').ToolDefinition[],
): Promise<AgentResponse> {
  const baseMessages = await buildMessages(ctx);
  const temperature = (name === 'coder' || name === 'reviewer') ? 0.1 : 0.7;
  // Merge native tools with any MCP tools registered for this session
  const tools = [
    ...getNativeTools(),
    ...(mcpTools ?? []),
  ];

  let projectRoot = process.cwd();
  if (ctx.projectIndex?.projectPath) {
    projectRoot = ctx.projectIndex.projectPath;
  }

  const toolCtx = { projectRoot, sessionId, taskId: ctx.taskId };
  const extraMessages: LLMMessage[] = [];

  let totalTokens = 0;
  let finalContent = '';

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const messages: LLMMessage[] = [...baseMessages, ...extraMessages];

    // Streaming strategy:
    // - When onToken is provided and we have no accumulated tool messages yet,
    //   try streaming (optimistic: most simple tasks finish in 1 turn).
    //   If the model returns tool calls on a streamed turn, we discard the
    //   partial stream and continue the loop with regular chat + tools.
    // - Tool-call turns (extraMessages has content): use regular chat with tools.
    // - Final answer after tool calls: stream it.
    let result: { content: string; toolCalls?: ToolCall[]; tokensUsed: number };

    const useStream = !!onToken && (extraMessages.length === 0 || (extraMessages.length > 0 && !extraMessages.some(m => m.role === 'tool')));

    if (useStream && extraMessages.length === 0) {
      // First turn — stream optimistically without tools (clean output)
      result = await streamChat(messages, { temperature }, onToken);
      if (result.toolCalls && result.toolCalls.length > 0) {
        // Model wants to call tools despite streaming — clear partial output and
        // rerun non-streaming with tools so tool calls are properly structured.
        printer.streamAbort();
        result = await chat(messages, { temperature, tools });
      }
    } else if (useStream) {
      // Final turn after tool calls — stream the summary response
      result = await streamChat(messages, { temperature }, onToken);
    } else {
      // Tool-call turns or noStream: regular chat with tools
      result = await chat(messages, { temperature, tools });
    }

    totalTokens += result.tokensUsed ?? 0;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      finalContent = result.content;
      // If we used streaming the content was already emitted token by token
      break;
    }

    // Append the assistant turn and execute all tool calls
    extraMessages.push({ role: 'assistant', content: result.content ?? '' });

    for (const tc of result.toolCalls) {
      logger.debug?.(`[tool] ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 120)})`);

      // Show a dim tool-use indicator so the user knows work is happening
      printer.dim(`  ⚙ ${tc.name}(${_formatToolArgs(tc)})`);

      const toolResult = await executeTool(tc, toolCtx);

      const MAX_TOOL_RESULT_CHARS = 12_000;
      const safeResult = toolResult.length > MAX_TOOL_RESULT_CHARS
        ? toolResult.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[... result truncated ...]'
        : toolResult;

      if (verbose) {
        printer.verboseToolResult(tc.name, safeResult);
      }

      extraMessages.push({ role: 'tool', content: safeResult, toolCallId: tc.id });
    }
  }

  // Fallback if we hit MAX_TOOL_ITERATIONS without a clean final response
  if (!finalContent) {
    const lastAssistant = [...extraMessages].reverse().find(m => m.role === 'assistant');
    finalContent = lastAssistant?.content ?? '[Agent reached maximum tool iterations without a final response]';
  }

  return { content: finalContent, tokensUsed: totalTokens };
}

/** Format the most relevant argument for display in the tool indicator line. */
function _formatToolArgs(tc: ToolCall): string {
  const a = tc.arguments;
  if (tc.name === 'read_file')      return String(Array.isArray(a.files) ? a.files.join(', ') : a.files ?? '');
  if (tc.name === 'write_file')     return String(a.file ?? '');
  if (tc.name === 'patch_file')     return String(a.file ?? '');
  if (tc.name === 'grep_search')    return String(a.pattern ?? '');
  if (tc.name === 'run_command')    return String(a.command ?? '').slice(0, 60);
  if (tc.name === 'git_command')    return `${a.action ?? ''} ${a.args ?? ''}`.trim();
  if (tc.name === 'web_search')     return String(a.query ?? '').slice(0, 60);
  if (tc.name === 'web_read_url')   return String(a.url ?? '').slice(0, 60);
  if (tc.name === 'list_directory') return String(a.path ?? '.');
  return '';
}

// ── Public orchestrator interface ─────────────────────────────────────────

export interface OrchestratorInput {
  userMessage: string;
  sessionId: number;
  projectId: number | null;
  previousTaskId?: number;
  /** When true, suppress streaming (e.g. programmatic callers like /swarm) */
  noStream?: boolean;
  /** When true, print each tool call result inline after execution */
  verbose?: boolean;
  /** MCP tool definitions to merge with native tools in the loop */
  mcpTools?: import('../llm/providers/base.js').ToolDefinition[];
}

export interface OrchestratorResult {
  taskId: number;
  intent: string;
  agent: AgentName;
  response: string;
  toolCalls?: ToolCall[];
  tokensUsed?: number;
  /** Steps executed if the auto-planner ran */
  planSteps?: string[];
}

export async function run(input: OrchestratorInput): Promise<OrchestratorResult> {
  const { userMessage, sessionId, projectId, previousTaskId, noStream, verbose, mcpTools } = input;

  try { cleanupStaleSessions(); } catch (err) {
    logger.debug?.('cleanupStaleSessions failed (non-fatal): ' + String(err));
  }

  // 1. Detect intent (slash command override or general)
  const { intent, agent } = detectIntent(userMessage);
  logger.debug(`Intent: ${intent}, Agent: ${agent}`);

  // 2. Create task record
  const task = createTask({ sessionId, projectId, intent, agent, input: userMessage });
  addMessage(task.id, 'user', userMessage);

  // 3. Build context (project index + git metadata + skills + history)
  const ctx = await buildContext({
    userMessage, agent, taskId: task.id, projectId, sessionId, previousTaskId,
  });

  // 4. Auto-planner: detect complex tasks and execute step-by-step
  const shouldPlan = !noStream && isComplexTask(userMessage) && !userMessage.startsWith('/');

  try {
    let finalResponse: string;
    let totalTokens = 0;
    let planSteps: string[] | undefined;

    if (shouldPlan) {
      // ── Planned execution ──────────────────────────────────────────────
      printer.dim('  🗺  Complex task detected — generating plan…');
      planSteps = await generatePlan(userMessage, ctx.projectIndex?.projectPath ?? process.cwd(), projectId);

      if (planSteps.length === 0) {
        // Plan generation failed — fall back to single-shot
        printer.dim('  ⚠  Plan generation returned empty — executing directly');
        planSteps = undefined;
      } else {
        printer.section(`Plan (${planSteps.length} steps)`);
        planSteps.forEach((s, i) => printer.dim(`  ${i + 1}. ${s}`));
        printer.blank();
      }
    }

    if (planSteps && planSteps.length > 0) {
      // Execute each step, feeding prior output as context
      let priorOutput = '';
      const stepResults: string[] = [];

      for (let i = 0; i < planSteps.length; i++) {
        const step = planSteps[i]!;
        printer.info(`Step ${i + 1}/${planSteps.length}: ${step}`);

        const stepMessage = priorOutput
          ? `${step}\n\n[Context from previous steps]\n${priorOutput}`
          : step;

        const stepCtx = await buildContext({
          userMessage: stepMessage,
          agent,
          taskId: task.id,
          projectId,
          sessionId,
          previousTaskId,
        });

        const isLastStep = i === planSteps.length - 1;
        let onToken: ((t: string) => void) | undefined;

        if (isLastStep && !noStream) {
          printer.streamStart();
          onToken = (t) => printer.streamToken(t);
        }

        const stepResult = await runAgent(agent, stepCtx, sessionId, onToken, verbose, mcpTools);

        if (isLastStep && !noStream) {
          printer.streamEnd();
        }

        totalTokens += stepResult.tokensUsed ?? 0;
        stepResults.push(`[Step ${i + 1}] ${stepResult.content}`);
        priorOutput = stepResult.content;
      }

      finalResponse = priorOutput; // last step is the final output
    } else {
      // ── Single-shot execution ──────────────────────────────────────────
      let onToken: ((t: string) => void) | undefined;
      if (!noStream) {
        printer.streamStart();
        onToken = (t) => printer.streamToken(t);
      }

      const agentResponse = await runAgent(agent, ctx, sessionId, onToken, verbose, mcpTools);

      if (!noStream) {
        printer.streamEnd();
      }

      finalResponse = agentResponse.content;
      totalTokens = agentResponse.tokensUsed ?? 0;
    }

    addMessage(task.id, 'assistant', finalResponse);
    completeTask(task.id, finalResponse, 'done');

    // Accumulate token usage for /cost reporting
    if (totalTokens > 0) trackTokens(sessionId, totalTokens);

    notify({
      event: 'task.completed',
      payload: { taskId: task.id, intent, agent, success: true },
      timestamp: new Date().toISOString(),
    }).catch(err => logger.debug?.('N8N notify failed: ' + String(err)));

    return {
      taskId: task.id,
      intent,
      agent,
      response: finalResponse,
      tokensUsed: totalTokens,
      planSteps,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    addMessage(task.id, 'assistant', message);
    completeTask(task.id, message, 'failed');
    throw err;
  }
}
