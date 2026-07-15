import { readFile } from 'fs/promises';
import path from 'path';
import { SKILLS_DIR } from '../config.js';
import type { Skill, AgentName } from '../types.js';
import { pathExists } from '../utils/fs-utils.js';

export interface SkillEntry {
  name: string;
  path: string;
  agent: AgentName;
  description?: string;
  triggers?: string[];
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

    entries.push({
      name: inferredName,
      path: entryPath,
      agent: (meta['agent'] ?? 'general') as AgentName,
      description: meta['description'],
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
  return scanSkillFiles(SKILLS_DIR);
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

export async function findBestSkillForQuery(query: string, currentAgent: AgentName): Promise<Skill | null> {
  const entries = await discoverSkills();
  const lowerQuery = query.toLowerCase();

  let bestMatch: SkillEntry | null = null;
  let highestScore = 0;

  for (const entry of entries) {
    // Skip references to keep matching to core skills
    if (entry.path.includes('/references/')) continue;

    let score = 0;

    // Check if query contains skill name exactly
    const skillName = entry.name.toLowerCase();
    if (lowerQuery.includes(skillName) || skillName.includes(lowerQuery)) {
      score += 10;
    }

    // Check triggers
    if (entry.triggers) {
      for (const trigger of entry.triggers) {
        if (lowerQuery.includes(trigger.toLowerCase())) {
          score += 5;
        }
      }
    }

    // Check description
    if (entry.description && lowerQuery.includes(entry.description.toLowerCase())) {
      score += 2;
    }

    // Boost if the skill belongs to the active agent type
    if (entry.agent === currentAgent) {
      score += 1;
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = entry;
    }
  }

  // We require a minimum match confidence score of 5
  if (bestMatch && highestScore >= 5) {
    return loadSkill(bestMatch.path);
  }

  return null;
}
