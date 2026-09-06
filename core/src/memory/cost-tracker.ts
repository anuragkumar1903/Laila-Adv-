/**
 * cost-tracker.ts
 *
 * Per-session token accumulator — lives in memory for the process lifetime.
 * Call trackTokens() after each orchestrator run to accumulate usage.
 * Call getSessionCost() + estimateCost() to display a /cost summary.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  taskCount: number;
  startedAt: number;
}

// ── In-memory session store ───────────────────────────────────────────────

const sessions = new Map<number, SessionCost>();

// ── Cost table (per 1M tokens) ────────────────────────────────────────────

const COST_PER_M: Record<string, { input: number; output: number }> = {
  'gpt-4o':                { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':           { input: 0.15,  output: 0.60  },
  'claude-sonnet-4-5':     { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet':     { input: 3.00,  output: 15.00 },
  'claude-3-haiku':        { input: 0.25,  output: 1.25  },
  'gemini-2.0-flash':      { input: 0.075, output: 0.30  },
  'gemini-2.5-flash':      { input: 0.075, output: 0.30  },
  'gemini-2.5-pro':        { input: 1.25,  output: 10.00 },
  'gemini-1.5-pro':        { input: 1.25,  output: 5.00  },
  'gemini-1.5-flash':      { input: 0.075, output: 0.30  },
  'ollama':                { input: 0,     output: 0     },
};

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Accumulate totalTokens for a session.
 * The tracker does not receive split input/output counts from the orchestrator
 * so both are stored as total (and input/output remain 0 until providers
 * expose the split).  taskCount is incremented on every call.
 */
export function trackTokens(sessionId: number, tokens: number): void {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.totalTokens += tokens;
    existing.taskCount  += 1;
  } else {
    sessions.set(sessionId, {
      inputTokens:  0,
      outputTokens: 0,
      totalTokens:  tokens,
      taskCount:    1,
      startedAt:    Date.now(),
    });
  }
}

/**
 * Get the accumulated cost record for a session, or null if never tracked.
 */
export function getSessionCost(sessionId: number): SessionCost | null {
  return sessions.get(sessionId) ?? null;
}

/**
 * Estimate the USD cost for `tokens` total tokens against a model.
 * Uses a 50/50 input/output split when we only have a combined total,
 * which is a reasonable approximation for conversational workloads.
 * Returns 0 for unknown models (safe fallback).
 */
export function estimateCost(tokens: number, model: string): number {
  // Find a matching entry — exact match first, then prefix match
  let rates = COST_PER_M[model];
  if (!rates) {
    const key = Object.keys(COST_PER_M).find(k => model.toLowerCase().startsWith(k.toLowerCase()));
    rates = key ? COST_PER_M[key] : undefined;
  }
  if (!rates) return 0;

  // Assume 50 / 50 split when we don't have the breakdown
  const half = tokens / 2;
  return ((half / 1_000_000) * rates.input) + ((half / 1_000_000) * rates.output);
}
