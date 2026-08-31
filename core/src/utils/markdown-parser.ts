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
  const regex = /```(\w+)\n([\s\S]*?)```/g;
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
