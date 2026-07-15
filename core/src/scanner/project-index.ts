import path from 'path';
import { ensureDir, writeJSON } from '../utils/fs-utils.js';
import { PROJECTS_DIR } from '../config.js';
import type { ScanResult, ProjectIndex } from '../types.js';

export function getProjectIndexPath(projectId: number): string {
  return path.join(PROJECTS_DIR, String(projectId), 'project-index.json');
}

export function getLegacyProjectIndexPath(projectPath: string): string {
  return path.join(projectPath, 'project-index.json');
}

export function buildProjectIndex(projectId: number, projectPath: string, scan: ScanResult): ProjectIndex {
  const filesByCategory = {
    controllers: [] as string[],
    services:    [] as string[],
    routes:      [] as string[],
    models:      [] as string[],
    tests:       [] as string[],
    configs:     [] as string[],
    schemas:     [] as string[],
    middleware:  [] as string[],
    utils:       [] as string[],
    other:       [] as string[],
  };

  const fileRecords = [] as NonNullable<ProjectIndex['filesMeta']>;

  for (const f of scan.files) {
    const record = {
      path: f.relPath,
      role: f.category,
      language: f.language,
      hash: f.hash,
    };

    switch (f.category) {
      case 'controller': filesByCategory.controllers.push(f.relPath); break;
      case 'service':    filesByCategory.services.push(f.relPath);    break;
      case 'route':      filesByCategory.routes.push(f.relPath);      break;
      case 'model':      filesByCategory.models.push(f.relPath);      break;
      case 'test':       filesByCategory.tests.push(f.relPath);       break;
      case 'config':     filesByCategory.configs.push(f.relPath);     break;
      case 'schema':     filesByCategory.schemas.push(f.relPath);     break;
      case 'middleware':  filesByCategory.middleware.push(f.relPath);  break;
      case 'util':       filesByCategory.utils.push(f.relPath);       break;
      default:           filesByCategory.other.push(f.relPath);        break;
    }
  }

  return {
    projectId,
    projectName: scan.projectName,
    projectPath,
    framework:  scan.framework,
    languages:  scan.languages,
    pkgManager: scan.pkgManager,
    summary: scan.summary,
    filesMeta: scan.files.map(f => ({
      path: f.relPath,
      role: f.category,
      language: f.language,
      hash: f.hash,
      symbols: f.symbols,
    })),
    routes: scan.routes ?? [],
    files: filesByCategory,
    tests: filesByCategory.tests.slice(),
    scannedAt: new Date(scan.scannedAt).toISOString(),
  };
}

/** Write project-index.json into the project root directory. */
export async function writeProjectIndex(projectPath: string, index: ProjectIndex): Promise<void> {
  await writeJSON(getProjectIndexPath(index.projectId), index);
  await writeJSON(getLegacyProjectIndexPath(projectPath), index);
}
