import { BaseAgent } from './base-agent.js';
import { buildMessages } from '../llm/prompt-builder.js';
import { chat } from '../llm/provider-factory.js';
import type { AgentContext, AgentResponse } from '../types.js';

/**
 * Specialist agent for documentation and technical writing.
 *
 * Instructs the model to produce well-structured Markdown targeted at
 * developers familiar with the project's stack. Disallows placeholder
 * text — every section must contain real content.
 *
 * Temperature: 0.5 — more creative than coding agents to allow natural prose.
 */
export class WriterAgent extends BaseAgent {
  readonly name = 'writer';

  override async run(ctx: AgentContext): Promise<AgentResponse> {
    const enrichedCtx: AgentContext = {
      ...ctx,
      userMessage:
        `${ctx.userMessage}\n\n` +
        `[Instructions]\n` +
        `- Write in clear, professional Markdown.\n` +
        `- Use headings, bullet points, and code blocks appropriately.\n` +
        `- Target an audience of developers familiar with the stack.\n` +
        `- Do NOT include placeholder text — every section must be real.`,
    };

    const messages = buildMessages(enrichedCtx);
    const result   = await chat(messages, { temperature: 0.5 });
    return { content: result.content, tokensUsed: result.tokensUsed };
  }
}
