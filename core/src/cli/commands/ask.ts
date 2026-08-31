import path from 'path';
import { getProvider } from '../../llm/provider-factory.js';
import { loadProviderConfig, isConfigComplete } from '../../config/config-loader.js';
import { endSession } from '../../memory/repositories/sessions.js';
import { findByPath, upsertProject } from '../../memory/repositories/projects.js';
import { bulkUpsertFiles } from '../../memory/repositories/indexes.js';
import { updateLastScanned } from '../../memory/repositories/projects.js';
import { run as orchestrate } from '../../orchestrator/orchestrator.js';
import { resolveInitialProjectPath, resolveWorkspace } from '../workspace.js';
import { scanProject } from '../../scanner/scanner.js';
import { buildProjectIndex, writeProjectIndex, getProjectIndexPath } from '../../scanner/project-index.js';
import { readJSON } from '../../utils/fs-utils.js';
import { getGitRemote } from '../../utils/git-utils.js';
import { printer } from '../ui/printer.js';
import { spinner } from '../ui/spinner.js';
import type { ScannedFile, ProjectIndex } from '../../types.js';

export async function askCommand(query: string): Promise<void> {
  if (!query) {
    printer.error('No query provided.');
    process.exit(1);
  }

  spinner.start('Checking LLM providerâ€¦');
  const config = await loadProviderConfig(process.cwd());
  if (!isConfigComplete(config)) {
    spinner.fail('No LLM provider configured. Run `laila start` first to complete setup.');
    process.exit(1);
  }
  const provider = await getProvider(process.cwd());
  const alive = await provider.healthCheck();
  if (!alive) {
    spinner.fail('Cannot reach the LLM provider. Check your connection or run `laila start` to reconfigure.');
    process.exit(1);
  }
  spinner.succeed('Provider ready');

  // Resolve workspace (uses active session if start is running, else CWD)
  let { sessionId, projectId, isTemporarySession } = resolveWorkspace();

  // If no project resolved via active session, try CWD-based auto-detection
  // This handles the case where laila ask is called standalone (no running session)
  if (projectId === null) {
    spinner.start('Detecting projectâ€¦');
    const detectedPath = await resolveInitialProjectPath();

    if (detectedPath) {
      const existing = findByPath(detectedPath);

      if (existing?.last_scanned) {
        // Already indexed â€” reuse without re-scanning
        projectId = existing.id;
        spinner.succeed(`Using indexed project: ${path.basename(detectedPath)}`);
      } else {
        // Project found but not indexed yet â€” scan it now
        spinner.update(`Scanning project: ${path.basename(detectedPath)}â€¦`);
        const scan = await scanProject(detectedPath);
        spinner.update(`Indexing ${scan.totalFiles} filesâ€¦`);

        const gitRemote = await getGitRemote(detectedPath);
        const project = upsertProject({
          name: scan.projectName,
          path: detectedPath,
          git_remote: gitRemote,
          framework: scan.framework,
          languages: JSON.stringify(scan.languages),
          pkg_manager: scan.pkgManager,
        });
        projectId = project.id;

        bulkUpsertFiles(projectId, scan.files.map((f: ScannedFile) => ({
          relPath: f.relPath,
          category: f.category,
          language: f.language,
          sizeBytes: f.sizeBytes,
        })));

        const index = buildProjectIndex(projectId, detectedPath, scan);
        await writeProjectIndex(detectedPath, index);
        updateLastScanned(projectId);

        spinner.succeed(`Scanned ${scan.totalFiles} files â€” project indexed`);
      }
    } else {
      spinner.succeed('No project detected â€” running in global mode');
    }
  } else if (projectId !== null) {
    // Active session has a project â€” check if index exists and load it
    // (no re-scan needed, context.ts will load the index)
    const existingProject = findByPath(process.cwd());
    if (!existingProject?.last_scanned) {
      // Session has projectId but that project's index may be stale â€” ok, context handles it
    }
  }

  try {
    spinner.start('Thinkingâ€¦');
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
