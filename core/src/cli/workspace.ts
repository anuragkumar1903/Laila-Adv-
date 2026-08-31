import path from 'path';
import { findAll, findByPath } from '../memory/repositories/projects.js';
import { createSession, findLatestActiveSession } from '../memory/repositories/sessions.js';
import { pathExists } from '../utils/fs-utils.js';

export interface ResolvedWorkspace {
  sessionId: number;
  projectId: number | null;
  isTemporarySession: boolean;
}

const PROJECT_MARKERS = [
  '.git', 'package.json', 'project-index.json',
  'Brain.md', 'BRAIN.md', 'tsconfig.json',
  'pyproject.toml', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', '.laila',
];

async function isProjectRoot(dir: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if (await pathExists(path.join(dir, marker))) return true;
  }
  return false;
}

export async function resolveInitialProjectPath(): Promise<string | null> {
  let dir = process.cwd();
  while (true) {
    if (await isProjectRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the active project by matching the current working directory
 * against registered projects.
 *
 * Resolution order:
 * 1. Use the active session if one exists (laila start is running)
 * 2. Exact CWD match against a registered project path
 * 3. CWD is inside a registered project path (subdirectory match)
 * 4. Walk parent directories to find a registered project
 * 5. Fall back to the most recently scanned project as a last resort
 * 6. null (global / no project mode)
 */
function resolveProjectFromCwd(): number | null {
  const cwd = process.cwd();
  const projects = findAll(); // ordered by last_scanned DESC

  if (projects.length === 0) return null;

  // 1. Exact match
  const exact = findByPath(cwd);
  if (exact) return exact.id;

  // 2. CWD is inside a registered project (longest prefix wins)
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const subDirMatch = projects
    .filter(p => {
      const normalizedPath = p.path.replace(/\\/g, '/');
      return normalizedCwd.startsWith(normalizedPath + '/') || normalizedCwd === normalizedPath;
    })
    .sort((a, b) => b.path.length - a.path.length)[0]; // longest match wins

  if (subDirMatch) return subDirMatch.id;

  // 3. Walk CWD parents looking for a registered project
  let dir = path.dirname(cwd);
  while (true) {
    const parentMatch = findByPath(dir);
    if (parentMatch) return parentMatch.id;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // 4. No match — fall back to most recently scanned project
  // This preserves old behavior but only as last resort
  return projects[0]?.id ?? null;
}

export function resolveWorkspace(): ResolvedWorkspace {
  // Always prefer an active session (user is in a running laila start)
  const activeSession = findLatestActiveSession();
  if (activeSession) {
    return {
      sessionId: activeSession.id,
      projectId: activeSession.project_id,
      isTemporarySession: false,
    };
  }

  // No active session — resolve project from CWD
  const projectId = resolveProjectFromCwd();
  const session = createSession(projectId);

  return {
    sessionId: session.id,
    projectId,
    isTemporarySession: true,
  };
}
