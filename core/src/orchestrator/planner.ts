/**
 * planner.ts
 *
 * Two responsibilities:
 *   1. isComplexTask()   — fast heuristic to decide if a task needs planning
 *   2. generatePlan()    — calls the LLM to produce a step list
 *
 * The orchestrator calls isComplexTask() before every run. If it returns true,
 * it invokes generatePlan(), then executes each step sequentially in the tool
 * loop, feeding prior step output as context to the next step. This mirrors
 * how Claude Code and Kiro handle multi-file or multi-concern tasks.
 */

import { chat } from '../llm/provider-factory.js';
import type { LLMMessage } from '../llm/providers/base.js';

// ── Complexity signals ────────────────────────────────────────────────────

/**
 * Keywords that reliably signal a multi-step task requiring planning.
 * "add X, Y, and Z" or "refactor ... and also add tests" are good examples.
 */
const COMPLEX_SIGNALS = [
  // Multi-concern conjunctions
  'and also', 'as well as', 'in addition', 'along with',
  // Full-feature requests
  'implement', 'scaffold', 'set up', 'integrate', 'add support for',
  'build a', 'create a', 'write a full', 'add full',
  // Cross-cutting concerns
  'with tests', 'with authentication', 'with auth', 'with validation',
  'with error handling', 'with logging', 'with documentation',
  // Multi-file verbs
  'refactor', 'migrate', 'convert', 'upgrade', 'restructure',
  // Explicit multi-step language
  'step by step', 'first ... then', 'plan', 'phases',
];

/**
 * Determine whether a user's message is complex enough to warrant planning.
 *
 * Heuristics (any one match triggers planning):
 *   1. Input is long (>180 chars) — suggests detailed, multi-part requirement
 *   2. Contains 2+ COMPLEX_SIGNALS — multi-concern request
 *   3. Contains a numbered list pattern (1. ... 2. ...) in the message
 *
 * This runs synchronously with zero LLM calls.
 */
export function isComplexTask(input: string): boolean {
  const lower = input.toLowerCase();

  // Signal 1: long message
  if (input.length > 180) return true;

  // Signal 2: at least 2 complexity keywords
  const signalCount = COMPLEX_SIGNALS.filter(s => lower.includes(s)).length;
  if (signalCount >= 2) return true;

  // Signal 3: numbered list in the input (user already structured it as steps)
  if (/\b[12]\.\s+\w/.test(input)) return true;

  return false;
}

/**
 * Ask the LLM to break a complex goal into sequential, actionable steps.
 *
 * Returns an array of step strings — each is a direct instruction for the
 * agent to execute. The orchestrator runs each step through the full tool
 * loop and feeds the result as context to the next step.
 */
export async function generatePlan(
  goal: string,
  projectPath: string,
  projectId: number | null,
): Promise<string[]> {
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `You are an expert software architect planning a complex task for an AI coding assistant.

Break the following goal into 3-7 discrete, sequential, and independently actionable steps.
Each step MUST be:
- Phrased as a direct instruction that an AI developer can execute in one go
- Concrete and specific (name files, modules, or features where possible)
- Focused: one concern per step (read first, then write; write code before writing tests)

Return ONLY a JSON array of strings. No markdown, no commentary, no numbering outside the array.
Example: ["Read the existing auth module to understand current patterns", "Add JWT middleware to src/middleware/auth.ts", "Update the user routes to require the middleware", "Write tests for the new auth flow"]`,
    },
    {
      role: 'user',
      content: `Goal: ${goal}`,
    },
  ];

  const result = await chat(messages, { temperature: 0.2 });

  // Try to extract a JSON array from the response
  try {
    // Allow for a leading/trailing ```json fence
    const jsonMatch = result.content.match(/```json\n?([\s\S]*?)```/) ||
                      result.content.match(/(\[[\s\S]*?\])/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : result.content.trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.every(s => typeof s === 'string')) {
      return parsed.filter(s => s.trim().length > 5);
    }
  } catch { /* fall through to line-based parse */ }

  // Fallback: parse as numbered/bulleted lines
  return result.content
    .split('\n')
    .map(l => l.replace(/^[\d\-*•.]+\s*/, '').trim())
    .filter(l => l.length > 5);
}
