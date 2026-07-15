import { readFileSafe } from '../../utils/fs-utils.js';
import path from 'path';

export interface ExtractedSymbols {
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
}

const IMPORT_RE = /(?:import\s+(?:(?:\{[^}]*\})|(?:\w+))\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const EXPORT_FN_RE = /export\s+(?:async\s+)?function\s+(\w+)/g;
const EXPORT_CLASS_RE = /export\s+(?:default\s+)?class\s+(\w+)/g;
const EXPORT_CONST_RE = /export\s+(?:const|let|var)\s+(\w+)/g;
const FUNCTION_RE = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\()/g;

/**
 * Extract imports, exports, functions, and classes from a TypeScript/JavaScript file.
 * Fast regex-based — no AST parsing required.
 */
export function extractSymbols(content: string): ExtractedSymbols {
  const imports: string[] = [];
  const exports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];

  for (const match of content.matchAll(IMPORT_RE)) {
    const mod = match[1] ?? match[2];
    if (mod) imports.push(mod);
  }

  for (const match of content.matchAll(EXPORT_FN_RE)) {
    if (match[1]) exports.push(match[1]);
  }

  for (const match of content.matchAll(EXPORT_CLASS_RE)) {
    if (match[1]) classes.push(match[1]);
  }

  for (const match of content.matchAll(EXPORT_CONST_RE)) {
    if (match[1]) exports.push(match[1]);
  }

  for (const match of content.matchAll(FUNCTION_RE)) {
    const name = match[1] ?? match[2];
    if (name) functions.push(name);
  }

  return { imports, exports, functions, classes };
}

/**
 * Build a dependency map: for each file, list what other project files it imports.
 */
export function buildDependencyMap(
  files: Array<{ relPath: string; symbols?: ExtractedSymbols }>,
): Map<string, string[]> {
  const pathSet = new Set(files.map(f => f.relPath));
  const depMap = new Map<string, string[]>();

  for (const file of files) {
    if (!file.symbols) continue;
    const deps: string[] = [];

    for (const imp of file.symbols.imports) {
      // Resolve relative imports to project-relative paths
      if (imp.startsWith('.')) {
        const dir = path.dirname(file.relPath);
        const resolved = path.posix.normalize(path.posix.join(dir.replace(/\\/g, '/'), imp));
        // Try common extensions
        for (const ext of ['', '.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js']) {
          const candidate = resolved + ext;
          if (pathSet.has(candidate)) {
            deps.push(candidate);
            break;
          }
        }
      }
    }

    depMap.set(file.relPath, deps);
  }

  return depMap;
}
