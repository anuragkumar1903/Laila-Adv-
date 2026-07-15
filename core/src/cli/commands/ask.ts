import { getProvider } from '../../llm/provider-factory.js';
import { loadProviderConfig, isConfigComplete } from '../../config/config-loader.js';
import { endSession } from '../../memory/repositories/sessions.js';
import { run as orchestrate } from '../../orchestrator/orchestrator.js';
import { resolveWorkspace } from '../workspace.js';
import { printer } from '../ui/printer.js';
import { spinner } from '../ui/spinner.js';

export async function askCommand(query: string): Promise<void> {
  if (!query) {
    printer.error('No query provided.');
    process.exit(1);
  }

  spinner.start('Checking LLM provider…');
  const config = await loadProviderConfig(process.cwd());
  if (!isConfigComplete(config)) {
    spinner.fail('No LLM provider configured. Run `laila-cli` first to complete setup.');
    process.exit(1);
  }
  const provider = await getProvider(process.cwd());
  const alive = await provider.healthCheck();
  if (!alive) {
    spinner.fail('Cannot reach the LLM provider. Check your connection or run `laila-cli` to reconfigure.');
    process.exit(1);
  }
  spinner.succeed('Provider ready');

  const { sessionId, projectId, isTemporarySession } = resolveWorkspace();

  try {
    spinner.start('Thinking…');
    const result = await orchestrate({
      userMessage: query,
      sessionId,
      projectId,
    });
    spinner.stop();

    printer.response(result.response);
  } catch (err: unknown) {
    spinner.fail();
    printer.error(err instanceof Error ? err.message : String(err));
  } finally {
    if (isTemporarySession) {
      endSession(sessionId);
    }
  }
}
