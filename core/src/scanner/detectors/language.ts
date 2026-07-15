import path from 'path';
import type { FileCategory } from '../../types.js';

const EXT_TO_LANG: Record<string, string> = {
  '.ts':'TypeScript', '.tsx':'TypeScript',
  '.js':'JavaScript', '.jsx':'JavaScript', '.mjs':'JavaScript', '.cjs':'JavaScript',
  '.py':'Python', '.rb':'Ruby', '.go':'Go', '.rs':'Rust',
  '.java':'Java', '.kt':'Kotlin', '.cs':'C#',
  '.cpp':'C++', '.cc':'C++', '.c':'C', '.h':'C/C++',
  '.php':'PHP', '.swift':'Swift', '.scala':'Scala',
  '.dart':'Dart', '.lua':'Lua',
  '.sql':'SQL', '.sh':'Shell', '.bash':'Shell', '.zsh':'Shell', '.ps1':'PowerShell',
  '.json':'JSON', '.yaml':'YAML', '.yml':'YAML', '.toml':'TOML', '.xml':'XML',
  '.html':'HTML', '.css':'CSS', '.scss':'SCSS', '.sass':'SASS', '.less':'LESS',
  '.md':'Markdown', '.mdx':'MDX',
  '.graphql':'GraphQL', '.gql':'GraphQL', '.proto':'Protobuf',
};

export function getLanguage(filePath: string): string | null {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? null;
}

/** Return language names sorted by frequency (most common first). */
export function detectLanguages(filePaths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const fp of filePaths) {
    const lang = getLanguage(fp);
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}
