/**
 * n8n-webhook.ts
 * 
 * Simple webhook client for Phase 8: N8N Integration.
 * Triggers external workflows (e.g. Slack/Discord notifications) when Laila tasks complete or fail.
 */
import { logger } from '../utils/logger.js';

export interface WebhookEvent {
  event: 'task_completed' | 'task_failed' | 'validation_failed';
  projectId: number | null;
  taskId?: number;
  message: string;
  details?: any;
}

export async function triggerN8nWebhook(payload: WebhookEvent): Promise<void> {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return; // Silent skip if N8N is not configured (optional integration)

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'laila-ai',
        timestamp: new Date().toISOString(),
        ...payload,
      }),
      // Fire-and-forget: timeout quickly so we don't block the CLI
      signal: AbortSignal.timeout(2000),
    });
    logger.debug?.(`N8N webhook fired for event: ${payload.event}`);
  } catch (err: any) {
    logger.debug?.(`Failed to fire N8N webhook: ${err.message}`);
  }
}
