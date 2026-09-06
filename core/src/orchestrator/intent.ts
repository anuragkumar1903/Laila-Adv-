import type { TaskIntent, AgentName } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Detect intent from user input.
 *
 * Explicit slash commands (/code, /review, /research, /write) are honoured
 * so users can force a specific agent. All other input routes to 'general'
 * — the model reads the tools it needs itself rather than being pre-classified
 * by fragile keyword matching.
 */
export function detectIntent(input: string): { intent: TaskIntent; agent: AgentName } {
  const agentMap: Record<TaskIntent, AgentName> = {
    code: 'coder', review: 'reviewer', research: 'researcher', write: 'writer', general: 'general',
  };

  // Slash command overrides — explicit user intent only
  if (input.startsWith('/')) {
    const cmd = input.trim().split(/\s+/)[0]?.toLowerCase();
    const map: Record<string, TaskIntent> = {
      '/code':     'code',
      '/plan':     'code',
      '/goal':     'code',
      '/review':   'review',
      '/research': 'research',
      '/write':    'write',
    };
    const intent = map[cmd as string];
    if (intent) {
      logger.debug?.(`Intent (slash override): ${intent}`);
      return { intent, agent: agentMap[intent] };
    }
  }

  // Everything else → general agent uses tools to figure out what it needs
  logger.debug?.('Intent: general (default — model decides)');
  return { intent: 'general', agent: 'general' };
}
