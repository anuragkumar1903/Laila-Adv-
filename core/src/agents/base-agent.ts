import { chat } from '../llm/provider-factory.js';
import { buildMessages } from '../llm/prompt-builder.js';
import type { AgentContext, AgentResponse } from '../types.js';

/**
 * Abstract base class for all Laila agent roles.
 *
 * Subclasses override {@link run} to enrich the {@link AgentContext} with
 * role-specific instructions before delegating to the active LLM provider.
 * The base implementation runs the context through the prompt builder and
 * calls `chat()` with default settings — suitable for agents that need no
 * additional prompt enrichment (e.g. {@link GeneralAgent}).
 */
export abstract class BaseAgent {
  /** Unique agent identifier — matches {@link AgentName}. */
  abstract readonly name: string;

  /**
   * Execute the agent for a single turn.
   *
   * @param ctx - Assembled context including project index, skill, history, and user message
   * @returns The LLM response content and token usage
   */
  async run(ctx: AgentContext): Promise<AgentResponse> {
    const messages = buildMessages(ctx);
    const result   = await chat(messages);
    return { content: result.content, tokensUsed: result.tokensUsed };
  }
}
