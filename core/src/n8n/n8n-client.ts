import { N8N_WEBHOOK_URL, N8N_ENABLED } from '../config.js';
import { logger } from '../utils/logger.js';
import type { N8nEvent } from '../types.js';

/**
 * Fire-and-forget webhook to N8N.
 * Silently fails if N8N is not enabled or unreachable.
 */
export async function notify(event: N8nEvent): Promise<void> {
  if (!N8N_ENABLED) return;

  try {
    const res = await fetch(N8N_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(event),
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.debug(`N8N webhook returned ${res.status}`);
    }
  } catch (err) {
    logger.debug(`N8N notify failed: ${String(err)}`);
  }
}
