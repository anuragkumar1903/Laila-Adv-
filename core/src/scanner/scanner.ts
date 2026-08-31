import path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import ignoreLib from 'ignore';
import { readFileSafe, readFileLines, isTextFile, getFileStat } from '../utils/fs-utils.js';
import { isGitRepo, getGitRemote } from '../utils/git-utils.js';
import { detectLanguages, getLanguage } from './detectors/language.js';
import { detectFrameworkFromPkg, detectFrameworkFromFiles } from './detectors/framework.js';
import { detectPackageManager } from './detectors/package-manager.js';
import { categoriseFile } from './detectors/structure.js';
import { extractSymbols } from './detectors/symbols.js';
import { SCAN_EXCLUDES } from '../config.js';
import type { ScanResult, ScannedFile, ProjectIndex, ProjectFileRecord } from '../types.js';

type PkgJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type RouteHit = {
  method: string;
  path: string;
  handler: string;
};

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Concurrency limiter — avoids EMFILE errors on large repos
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function inferNextRoute(relPath: string): RouteHit | null {
  const normalized = relPath.replace(/\\/g, '/');
  const match = normalized.match(/(^|\/)(pages|app)\/(.+)\.(ts|tsx|js|jsx)$/i);
  if (!match) return null;

  const routePart = (match[3] ?? '')
    .replace(/\/index$/, '')
    .replace(/\/page$/, '')
    .replace(/\[(?:\.\.\.)?[^\]]+\]/g, ':param')
    .replace(/\\/g, '/');

  const routePath = routePart.length > 0 ? `/${routePart}`.replace(/\/+/g, '/') : '/';
  return { method: 'GET', path: routePath, handler: relPath };
}

async function extractRoutes(projectRoot: string, files: Array<{ relPath: string; category: string; language: string | null }>): Promise<RouteHit[]> {
  const hits: RouteHit[] = [];

  for (const file of files) {
    const nextRoute = inferNextRoute(file.relPath);
    if (nextRoute) {
      hits.push(nextRoute);
      continue;
    }

    if (file.category !== 'route' && file.category !== 'controller') continue;
    if (!file.language || !['TypeScript', 'JavaScript'].includes(file.language)) continue;

    const filePath = path.join(projectRoot, file.relPath);
    const content = await readFileSafe(filePath);
    if (!content) continue;

    const routeRegex = /(?:router|app)\.(get|post|put|patch|delete|options|head)\(\s*['"`]([^'"`]+)['"`]/gi;
    for (const match of content.matchAll(routeRegex)) {
      const method = (match[1] ?? 'get').toUpperCase();
      const routePath = match[2] ?? '/';
      hits.push({ method, path: routePath, handler: file.relPath });
    }
  }

  return hits;
}

/**
 * Scan a project directory and produce a {@link ScanResult}.
 *
 * Steps:
 * 1. Build ignore rules from {@link SCAN_EXCLUDES} and `.gitignore`
 * 2. Glob all non-binary files under `projectPath`
 * 3. Categorise each file (controller / service / route / model / test / …)
 * 4. Detect framework, languages, package manager, and git remote
 * 5. Extract route definitions (Express router patterns + Next.js page routes)
 *
 * Incremental mode: if `previousIndex` is provided, files whose `mtime`
 * has not changed since the last scan are reused without re-reading,
 * reducing I/O significantly on large repos.
 *
 * @param projectPath    - Absolute or relative path to the project root
 * @param previousIndex  - Optional previous scan result for incremental reuse
 * @returns A {@link ScanResult} containing all categorised files and metadata
 */
export async function scanProject(projectPath: string, previousIndex?: ProjectIndex | null): Promise<ScanResult> {
  const absPath = path.resolve(projectPath);

  // ── Build ignore rules ──────────────────────────────────────────────────
  const ig = ignoreLib();
  ig.add(SCAN_EXCLUDES);

  const gitignoreContent = await readFileSafe(path.join(absPath, '.gitignore'));
  if (gitignoreContent) ig.add(gitignoreContent);

  // ── Glob all files ──────────────────────────────────────────────────────
  const rawPaths = await glob('**/*', {
    cwd: absPath,
    nodir: true,
    dot: true,
    follow: false,
  });

  const filteredPaths = rawPaths.filter(p => !ig.ignores(p) && isTextFile(p));

  // ── Categorise files (Incremental) ──────────────────────────────────────
  const prevFiles = new Map<string, ProjectFileRecord>();
  if (previousIndex?.filesMeta) {
    for (const fm of previousIndex.filesMeta) prevFiles.set(fm.path, fm);
  }
  const scannedAtMs = previousIndex ? new Date(previousIndex.scannedAt).getTime() : 0;
  let reusedCount = 0;

  const files: ScannedFile[] = await mapConcurrent(
    filteredPaths,
    64,
    async (relPath): Promise<ScannedFile> => {
      const absFilePath = path.join(absPath, relPath);
      const stat = await getFileStat(absFilePath);
      
      const prev = prevFiles.get(relPath);
      const mtimeMs = stat ? stat.mtimeMs : Date.now();

      // Reuse previous metadata if the file was last modified at least 1 second
      // before the previous scan completed. The 1s buffer guards against files
      // that were written during the scan itself having their old metadata reused.
      if (prev && stat && mtimeMs < scannedAtMs - 1_000) {
        reusedCount++;
        return {
          relPath,
          category: prev.role,
          language: prev.language,
          sizeBytes: stat.size,
          hash: prev.hash,
          symbols: prev.symbols,
        };
      }

      // Otherwise read and hash
      const content = await readFileSafe(absFilePath);
      const language = getLanguage(relPath);
      let symbols;
      if (content && (language === 'TypeScript' || language === 'JavaScript')) {
        symbols = extractSymbols(content);
      }

      return {
        relPath,
        category: categoriseFile(relPath),
        language,
        sizeBytes: stat ? stat.size : 0,
        hash: content ? hashContent(content) : '',
        symbols,
        content: content ?? undefined,
      };
    }
  );

  // ── Detect metadata ─────────────────────────────────────────────────────
  let framework: string | null = null;
  let projectName = path.basename(absPath);

  const pkgJson = await readFileSafe(path.join(absPath, 'package.json'))
    .then(c => c ? JSON.parse(c) as PkgJson : null)
    .catch(() => null);

  if (pkgJson) {
    framework = detectFrameworkFromPkg(pkgJson);
    if (pkgJson.name) projectName = pkgJson.name;
  }

  if (!framework) {
    framework = detectFrameworkFromFiles(filteredPaths);
  }

  const languages = detectLanguages(filteredPaths);
  const pkgManager = await detectPackageManager(absPath);
  const gitRemote  = (await isGitRepo(absPath)) ? await getGitRemote(absPath) : null;
  const routes = await extractRoutes(absPath, files);

  const summary = [
    `${projectName} (${framework ?? 'unknown framework'})`,
    `${files.length} files`,
    `${languages.slice(0, 4).join(', ') || 'unknown languages'}`,
    routes.length ? `${routes.length} routes` : 'no routes detected',
  ].join(' • ');

  return {
    projectName,
    framework,
    languages,
    pkgManager,
    gitRemote,
    files,
    totalFiles: files.length,
    reusedFiles: reusedCount,
    routes,
    summary,
    scannedAt: Date.now(),
  };
}
