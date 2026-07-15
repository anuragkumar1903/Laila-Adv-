import { BaseAgent } from './base-agent.js';

/**
 * Fallback agent for general-purpose assistance.
 *
 * Used when intent detection cannot confidently classify the user's request
 * into a specialist category. Inherits the default {@link BaseAgent.run}
 * implementation with no additional prompt enrichment — behaviour is
 * governed entirely by the `general-assistant` skill.
 */
export class GeneralAgent extends BaseAgent {
  readonly name = 'general';
  // No enrichment — uses the base run() as-is with the general-assistant skill
}
