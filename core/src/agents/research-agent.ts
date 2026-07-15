import { BaseAgent } from './base-agent.js';
import type { AgentContext, AgentResponse } from '../types.js';
import { buildMessages } from '../llm/prompt-builder.js';
import { chat } from '../llm/provider-factory.js';

/**
 * Specialist agent for technical research and explanation.
 *
 * Instructs the model to produce clear, accurate explanations backed by
 * project-context file references where applicable. Avoids padding and
 * prefers concise answers with illustrative examples.
 *
 * Temperature: 0.4 — balanced between factual accuracy and readability.
 */
export class ResearchAgent extends BaseAgent {
  readonly name = 'researcher';

  override async run(ctx: AgentContext): Promise<AgentResponse> {
    const enrichedCtx: AgentContext = {
      ...ctx,
      userMessage:
        `${ctx.userMessage}\n\n` +
        `[Instructions]\n` +
        `- Provide a clear, accurate explanation.\n` +
        `- Use examples where helpful.\n` +
        `- Be concise — avoid padding.\n` +
        `- If referencing the project codebase, cite the specific file.`,
    };

    const messages = buildMessages(enrichedCtx);
    const result   = await chat(messages, { temperature: 0.4 });
    return { content: result.content, tokensUsed: result.tokensUsed };
  }
}
