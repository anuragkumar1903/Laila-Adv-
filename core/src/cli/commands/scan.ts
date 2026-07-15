import path from 'path';
import { scanProject } from '../../scanner/scanner.js';
import { buildProjectIndex, writeProjectIndex, getProjectIndexPath, getLegacyProjectIndexPath } from '../../scanner/project-index.js';
import { upsertProject, updateLastScanned, findByPath } from '../../memory/repositories/projects.js';
import { bulkUpsertFiles } from '../../memory/repositories/indexes.js';
import { getGitRemote } from '../../utils/git-utils.js';
import { pathExists, readJSON } from '../../utils/fs-utils.js';
import { printer } from '../ui/printer.js';
import { spinner } from '../ui/spinner.js';
import type { ScannedFile, ProjectIndex } from '../../types.js';

export async function scanCommand(targetPath?: string): Promise<void> {
  const resolvedPath = path.resolve(targetPath || '.');
  
  if (!await pathExists(resolvedPath)) {
    printer.error(`Path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  spinner.start(`Scanning ${resolvedPath}…`);

  try {
    const existing = findByPath(resolvedPath);
    let previousIndex: ProjectIndex | null = null;
    if (existing) {
      previousIndex = await readJSON<ProjectIndex>(getProjectIndexPath(existing.id))
        ?? await readJSON<ProjectIndex>(getLegacyProjectIndexPath(resolvedPath));
    }

    const scan = await scanProject(resolvedPath, previousIndex);
    spinner.update(`Indexing ${scan.totalFiles} files…`);

    const gitRemote = await getGitRemote(resolvedPath);
    const project = upsertProject({
      name: scan.projectName,
      path: resolvedPath,
      git_remote: gitRemote,
      framework: scan.framework,
      languages: JSON.stringify(scan.languages),
      pkg_manager: scan.pkgManager,
    });

    const projectId = project.id;

    bulkUpsertFiles(projectId, scan.files.map((f: ScannedFile) => ({
      relPath: f.relPath,
      category: f.category,
      language: f.language,
      sizeBytes: f.sizeBytes,
    })));

    const index = buildProjectIndex(projectId, resolvedPath, scan);
    await writeProjectIndex(resolvedPath, index);
    updateLastScanned(projectId);

    spinner.succeed(`Successfully scanned ${scan.totalFiles} files (${scan.reusedFiles} unchanged files reused)`);

    printer.blank();
    printer.table([
      ['Project Name', scan.projectName],
      ['Framework', scan.framework ?? 'unknown'],
      ['Languages', scan.languages.join(', ') || 'unknown'],
      ['Pkg manager', scan.pkgManager ?? 'unknown'],
      ['Git remote', scan.gitRemote ?? 'none'],
    ]);
  } catch (err: unknown) {
    spinner.fail('Scan failed');
    printer.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
