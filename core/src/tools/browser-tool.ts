import { chromium } from 'playwright';
import path from 'path';

export interface BrowserBlock {
  url: string;
  action: 'screenshot' | 'html' | 'text';
}

export function parseBrowserBlocks(response: string): BrowserBlock[] {
  const blocks: BrowserBlock[] = [];
  const regex = /```browser\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    if (!match[1]) continue;
    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean);
    const block: Partial<BrowserBlock> = {};
    for (const line of lines) {
      if (line.startsWith('url:')) block.url = line.slice(4).trim();
      else if (line.startsWith('action:')) block.action = line.slice(7).trim() as any;
    }
    if (block.url) {
      blocks.push({
        url: block.url,
        action: block.action || 'screenshot'
      });
    }
  }
  return blocks;
}

export async function runBrowserTool(projectRoot: string, block: BrowserBlock): Promise<string> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Capture console logs
    const logs: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        logs.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', err => logs.push(`[uncaught exception] ${err.message}`));

    await page.goto(block.url, { waitUntil: 'networkidle', timeout: 15000 });
    
    let result = `=== Browser Navigation to ${block.url} ===\n`;
    result += `Title: ${await page.title()}\n`;
    if (logs.length > 0) {
      result += `\nConsole Errors/Warnings:\n${logs.join('\n')}\n`;
    } else {
      result += `\nConsole: No errors detected.\n`;
    }

    if (block.action === 'screenshot') {
      const lailaDir = path.join(projectRoot, '.laila');
      import('fs').then(fs => fs.mkdirSync(lailaDir, { recursive: true }));
      const shotPath = path.join(lailaDir, `browser_shot_${Date.now()}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });
      result += `\nScreenshot saved to: ${shotPath}\n(Hint: You can use this file path with vision models to analyze the UI.)\n`;
    } else if (block.action === 'text') {
      const text = await page.evaluate(() => (globalThis as any).document.body.innerText);
      result += `\nPage Text:\n${text.slice(0, 3000)}...\n`;
    } else if (block.action === 'html') {
      const html = await page.content();
      result += `\nPage HTML:\n${html.slice(0, 3000)}...\n`;
    }

    return result;
  } catch (err: any) {
    return `=== Browser Error (${block.url}) ===\nFailed to load: ${err.message}`;
  } finally {
    if (browser) await browser.close();
  }
}

export async function takeScreenshot(url: string, projectRoot: string): Promise<string> {
  const lailaDir = path.join(projectRoot, '.laila');
  await import('fs/promises').then(fs => fs.mkdir(lailaDir, { recursive: true }));
  const shotPath = path.join(lailaDir, `snapshot_${Date.now()}.png`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    await page.screenshot({ path: shotPath, fullPage: true });
    return shotPath;
  } finally {
    if (browser) await browser.close();
  }
}
