import type { TaskIntent, AgentName } from '../types.js';
import { logger } from '../utils/logger.js';

// ── Keyword maps ───────────────────────────────────────────────────────────

/** Keywords that indicate a code-generation or modification request. */
const CODE_KEYWORDS = [
  'implement', 'create', 'add', 'build', 'write code', 'generate',
  'function', 'class', 'method', 'endpoint', 'api', 'route',
  'fix bug', 'bug fix', 'debug', 'refactor', 'optimise', 'optimize',
  'update function', 'modify', 'change implementation',
  'scaffold', 'boilerplate',
];

/** Keywords that indicate a code-review or audit request. */
const REVIEW_KEYWORDS = [
  'review', 'check', 'audit', 'analyse', 'analyze', 'inspect',
  'is this good', 'any issues', 'feedback', 'critique', 'evaluate',
  'code quality', 'what do you think', 'look at this',
];

/** Keywords that indicate an explanation or research request. */
const RESEARCH_KEYWORDS = [
  'explain', 'how does', 'what is', 'why', 'research',
  'understand', 'show me', 'tell me about', 'describe',
  'what are', 'difference between', 'compare', 'when should',
  'best practice', 'how to', 'tutorial',
];

/** Keywords that indicate a documentation or writing request. */
const WRITE_KEYWORDS = [
  'write docs', 'document', 'readme', 'documentation',
  'write a guide', 'create docs', 'jsdoc', 'comment',
  'changelog', 'release notes', 'api docs',
];

/**
 * Count how many keywords from `keywords` appear in `text` (case-insensitive).
 *
 * @param text     - Input string to search
 * @param keywords - List of keyword phrases to match
 * @returns Number of matched keywords
 */
function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((n, kw) => (lower.includes(kw) ? n + 1 : n), 0);
}

/**
 * Detect the user's intent from their raw input using keyword scoring.
 * Fast — no LLM call required.
 *
 * Tie-breaking: when multiple intents score equally, the priority order
 * code > review > research > write > general is used so that actionable
 * intents are preferred over explanatory ones.
 */
export function detectIntent(input: string): { intent: TaskIntent; agent: AgentName } {
  const agentMap: Record<TaskIntent, AgentName> = { code: 'coder', review: 'reviewer', research: 'researcher', write: 'writer', general: 'general' };
  
  // Slash commands override
  if (input.startsWith('/')) {
    const cmd = input.trim().split(/\s+/)[0]?.toLowerCase();
    const map: Record<string, TaskIntent> = { '/code': 'code', '/plan': 'code', '/goal': 'code', '/review': 'review', '/research': 'research', '/write': 'write' };
    const intent = map[cmd as string];
    if (intent) return { intent, agent: agentMap[intent] };
  }

  // Priority used when scores tie (lower index = higher priority)
  const PRIORITY: TaskIntent[] = ['code', 'review', 'research', 'write', 'general'];

  const scores: Record<TaskIntent, number> = {
    code:     countMatches(input, CODE_KEYWORDS),
    review:   countMatches(input, REVIEW_KEYWORDS),
    research: countMatches(input, RESEARCH_KEYWORDS),
    write:    countMatches(input, WRITE_KEYWORDS),
    general:  0,
  };

  const candidates = (Object.entries(scores) as Array<[TaskIntent, number]>)
    .filter(([, s]) => s > 0)
    .sort((a, b) => {
      // Primary sort: descending score
      if (b[1] !== a[1]) return b[1] - a[1];
      // Secondary sort: priority index ascending (lower = higher priority)
      return PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]);
    });

  if (candidates.length > 1 && candidates[0]![1] === candidates[1]![1]) {
    // Log tie even after priority resolution for visibility
    logger.debug?.(
      `Intent tie at score ${candidates[0]![1]}: ` +
      candidates.filter(([, s]) => s === candidates[0]![1]).map(([i]) => i).join(', ') +
      ` — resolved to "${candidates[0]![0]}" by priority`,
    );
  }

  const intent: TaskIntent = candidates[0]?.[0] ?? 'general';

  logger.debug?.(`Intent detected: ${intent} (scores: ${JSON.stringify(scores)})`);

  return { intent, agent: agentMap[intent] };
}
