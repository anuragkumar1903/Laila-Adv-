/**
 * Extracts all markdown fence blocks sequentially to preserve the order 
 * intended by the LLM. 
 */
export interface MarkdownBlock {
  language: string;
  content: string;
  raw: string;
}

export function parseAllBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  // More resilient regex: tolerates leading spaces/tabs, \r\n, and hyphens in language name
  const regex = /^[ \t]*```([A-Za-z0-9_-]+)[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gm;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: (match[1] ?? '').toLowerCase(),
      content: (match[2] ?? '').trim(),
      raw: match[0],
    });
  }
  return blocks;
}
