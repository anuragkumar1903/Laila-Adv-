import { BaseAgent } from './base-agent.js';
import { buildMessages } from '../llm/prompt-builder.js';
import { chat } from '../llm/provider-factory.js';
import type { AgentContext, AgentResponse } from '../types.js';

/**
 * Specialist agent for code review and quality analysis.
 *
 * Enriches the user message with a structured checklist covering bugs,
 * security, performance, clarity, edge cases, and test coverage.
 * Each issue in the response is labelled with severity (Critical / High /
 * Medium / Low), file location, and a suggested fix.
 *
 * Temperature: 0.3 — slightly deterministic to keep reviews consistent.
 */
export class ReviewerAgent extends BaseAgent {
  readonly name = 'reviewer';

  override async run(ctx: AgentContext): Promise<AgentResponse> {
    const enrichedCtx: AgentContext = {
      ...ctx,
      userMessage:
        `${ctx.userMessage}\n\n` +
        `[Review checklist]\n` +
        `1. Bugs and logic errors\n` +
        `2. Security vulnerabilities (injection, auth, etc.)\n` +
        `3. Performance issues\n` +
        `4. Code clarity and maintainability\n` +
        `5. Missing edge case handling\n` +
        `6. Test coverage gaps\n\n` +
        `Format: list each issue with severity (Critical / High / Medium / Low), ` +
        `location, and a suggested fix.`,
    };

    const messages = buildMessages(enrichedCtx);
    const result   = await chat(messages, { temperature: 0.3 });
    return { content: result.content, tokensUsed: result.tokensUsed };
  }
}
