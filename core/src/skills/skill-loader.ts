import { readFile } from 'fs/promises';
import path from 'path';
import { SKILLS_DIR } from '../config.js';
import type { Skill, AgentName } from '../types.js';
import { pathExists } from '../utils/fs-utils.js';

// Module-level cache — shared across all callers within the same process.
// Avoids duplicate filesystem scans from context.ts, skill-registry.ts,
// and findBestSkillForQuery() all calling discoverSkills() independently.
let _skillCache: SkillEntry[] | null = null;

export interface SkillEntry {
  name: string;
  path: string;
  agent: AgentName;
  description?: string;
  triggers?: string[];
}

export interface RankedSkillEntry extends SkillEntry {
  score: number;
}

async function resolveSkillPath(fileName: string): Promise<string> {
  const normalized = fileName.replace(/\\/g, '/').replace(/\.md$/i, '');
  const candidates = [
    path.join(SKILLS_DIR, `${normalized}.md`),
    path.join(SKILLS_DIR, normalized, 'skill.md'),
    path.join(SKILLS_DIR, normalized, 'index.md'),
    path.join(SKILLS_DIR, normalized),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  return candidates[0] as string;
}

async function scanSkillFiles(rootDir: string, entries: SkillEntry[] = []): Promise<SkillEntry[]> {
  const { readdir } = await import('fs/promises');
  const dirEntries = await readdir(rootDir, { withFileTypes: true });

  for (const dirEntry of dirEntries) {
    const entryPath = path.join(rootDir, dirEntry.name);

    if (dirEntry.isDirectory()) {
      await scanSkillFiles(entryPath, entries);
      continue;
    }

    if (!dirEntry.isFile() || !dirEntry.name.toLowerCase().endsWith('.md')) continue;

    const raw = await readFile(entryPath, 'utf-8').catch(() => '');
    const { meta } = parseFrontmatter(raw);
    const relative = path.relative(SKILLS_DIR, entryPath).replace(/\\/g, '/');
    const baseName = path.basename(entryPath, '.md');
    const inferredName = meta['name'] ?? (relative.toLowerCase().endsWith('/skill.md') || relative.toLowerCase().endsWith('/index.md')
      ? path.basename(path.dirname(entryPath))
      : baseName);
      
    // Ponytail Dynamic Reference Check: See if a 'references/' folder exists next to this skill
    let refNote = '';
    try {
      const refPath = path.join(path.dirname(entryPath), 'references');
      const { readdir } = await import('fs/promises');
      const refs = await readdir(refPath, { withFileTypes: true });
      const refFiles = refs.filter(r => r.isFile()).map(r => r.name);
      if (refFiles.length > 0) {
        refNote = `\n(Available reference docs: ${refFiles.join(', ')}. Use shell tools to read them from ${refPath.replace(/\\/g, '/')} if needed.)`;
      }
    } catch {
      // No references folder, ignore
    }

    entries.push({
      name: inferredName,
      path: entryPath,
      agent: (meta['agent'] ?? 'general') as AgentName,
      description: (meta['description'] ?? '') + refNote,
      triggers: meta['triggers'] ? meta['triggers'].split(',').map(t => t.trim()) : [],
    });
  }

  return entries;
}

/** Parse the YAML-like frontmatter between --- delimiters. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: raw };

  const [, frontmatter = '', body = ''] = fmMatch;
  const meta: Record<string, string> = {};

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = val;
  }

  return { meta, body };
}

function inferSkillName(filePath: string): string {
  const relative = path.relative(SKILLS_DIR, filePath).replace(/\\/g, '/');
  if (relative.endsWith('/skill.md') || relative.endsWith('/index.md')) {
    return path.basename(path.dirname(filePath));
  }
  return path.basename(filePath, path.extname(filePath));
}

export async function discoverSkills(): Promise<SkillEntry[]> {
  if (!await pathExists(SKILLS_DIR)) return [];
  // Always rescan the skills directory so newly added .md files
  // are discovered mid-session without requiring a restart.
  // The scan is fast (just readdir + frontmatter parse of small files).
  const result = await scanSkillFiles(SKILLS_DIR);
  _skillCache = result;
  return result;
}

/** Invalidate the in-process skill cache (e.g. after hot-reloading skills). */
export function invalidateSkillCache(): void {
  _skillCache = null;
}

export async function findSkillEntry(fileName: string): Promise<SkillEntry | null> {
  const normalized = fileName.replace(/\\/g, '/').replace(/\.md$/i, '');
  const entries = await discoverSkills();
  return entries.find(entry => {
    const entryBase = entry.name.toLowerCase();
    const requested = normalized.toLowerCase();
    return entryBase === requested || entry.path.toLowerCase().endsWith(`${requested}.md`);
  }) ?? null;
}

export async function loadSkill(fileName: string): Promise<Skill> {
  // If an absolute path is passed directly (e.g. from discoverSkills match.path),
  // skip the discovery/resolve step and read it straight away.
  const isAbsolute = path.isAbsolute(fileName);
  let filePath: string;

  if (isAbsolute) {
    filePath = fileName;
  } else {
    const discovered = await findSkillEntry(fileName);
    filePath = discovered?.path ?? await resolveSkillPath(fileName);
  }

  // ── Path traversal guard ──────────────────────────────────────────────
  // Resolve to a canonical absolute path and confirm it sits inside SKILLS_DIR.
  // This prevents an LLM-injected absolute path like /etc/passwd or ../../secret
  // from being read as a "skill" file.
  const resolved = path.resolve(filePath);
  const skillsRoot = path.resolve(SKILLS_DIR);
  if (!resolved.startsWith(skillsRoot + path.sep) && resolved !== skillsRoot) {
    throw new Error(
      `Skill path traversal blocked: "${resolved}" is outside SKILLS_DIR "${skillsRoot}"`,
    );
  }

  if (!await pathExists(filePath)) {
    throw new Error(`Skill file not found: ${filePath}`);
  }

  const raw = await readFile(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);

  return {
    name:    meta['name']    ?? inferSkillName(filePath),
    version: meta['version'] ?? '1.0',
    agent:   (meta['agent']  ?? 'general') as AgentName,
    content: body.trim(),
  };
}

export async function loadSkillSafe(fileName: string): Promise<Skill | null> {
  try { return await loadSkill(fileName); } catch { return null; }
}

function isReferenceSkill(entry: SkillEntry): boolean {
  const normalized = entry.path.replace(/\\/g, '/');
  return normalized.includes('/references/');
}

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9+#.]+/g) ?? []).filter(w => w.length > 2));
}

export function scoreSkillForQuery(
  entry: SkillEntry,
  query: string,
  currentAgent: AgentName,
  framework?: string | null,
  languages?: string[],
): number {
  const lowerQuery = query.toLowerCase();
  const queryWords = words(query);
  const name = entry.name.toLowerCase();
  const haystack = words([entry.name, entry.description ?? '', ...(entry.triggers ?? [])].join(' '));

  let score = entry.agent === currentAgent ? 1 : 0;

  // ── Direct name match in query (strongest signal) ─────────────────────
  if (lowerQuery.includes(name)) score += 12;

  // ── Partial name fragment match (e.g. "react" in "react-expert") ──────
  const nameFragments = name.split(/[-_./]/);
  for (const frag of nameFragments) {
    if (frag.length > 2 && lowerQuery.includes(frag)) score += 4;
  }

  // ── Trigger keyword match ─────────────────────────────────────────────
  for (const trigger of entry.triggers ?? []) {
    if (trigger && lowerQuery.includes(trigger.toLowerCase())) score += 8;
  }

  // ── Word overlap between query and skill metadata ─────────────────────
  for (const word of queryWords) {
    if (haystack.has(word)) score += 2;
  }

  // ── Framework match (from project-index.json) ─────────────────────────
  if (framework) {
    const fw = framework.toLowerCase();
    if (name.includes(fw)) score += 10;
    for (const frag of nameFragments) {
      if (frag.length > 2 && fw.includes(frag)) score += 6;
    }
    if (haystack.has(fw)) score += 4;
  }

  // ── Language match (from project-index.json) ──────────────────────────
  if (languages) {
    for (const lang of languages) {
      const l = lang.toLowerCase();
      if (name.includes(l)) score += 6;
      if (haystack.has(l)) score += 3;
    }
  }

  return score;
}

export async function rankSkillsForQuery(
  query: string,
  currentAgent: AgentName,
  limit = 3,
  framework?: string | null,
  languages?: string[],
): Promise<RankedSkillEntry[]> {
  const entries = await discoverSkills();
  return entries
    .filter(entry => !isReferenceSkill(entry))
    .map(entry => ({ ...entry, score: scoreSkillForQuery(entry, query, currentAgent, framework, languages) }))
    .filter(entry => entry.score >= 5)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export async function findBestSkillForQuery(
  query: string,
  currentAgent: AgentName,
  framework?: string | null,
  languages?: string[],
): Promise<Skill | null> {
  const [bestMatch] = await rankSkillsForQuery(query, currentAgent, 1, framework, languages);
  if (bestMatch) return loadSkill(bestMatch.path);

  return null;
}
