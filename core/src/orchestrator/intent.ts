import type { TaskIntent, AgentName } from '../types.js';

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
 */
export function detectIntent(input: string): { intent: TaskIntent; agent: AgentName } {
  const scores: Record<TaskIntent, number> = {
    code:     countMatches(input, CODE_KEYWORDS),
    review:   countMatches(input, REVIEW_KEYWORDS),
    research: countMatches(input, RESEARCH_KEYWORDS),
    write:    countMatches(input, WRITE_KEYWORDS),
    general:  0,
  };

  const best = (Object.entries(scores) as Array<[TaskIntent, number]>)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])[0];

  const intent: TaskIntent = best?.[0] ?? 'general';

  const agentMap: Record<TaskIntent, AgentName> = {
    code:     'coder',
    review:   'reviewer',
    research: 'researcher',
    write:    'writer',
    general:  'general',
  };

  return { intent, agent: agentMap[intent] };
}
