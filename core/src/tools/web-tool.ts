/**
 * web-tool.ts
 * 
 * LLM-invokable web search and url extraction via ```search and ```url fence blocks.
 * 
 * ── Fence format ─────────────────────────────────────────────────────────
 * 
 *   ```search
 *   query: latest news about nvidia
 *   ```
 * 
 *   ```url
 *   url: https://example.com/article
 *   ```
 * 
 * Security:
 *  - URLs are validated against localhost and private IPs to prevent SSRF.
 *  - HTML content is aggressively stripped and truncated to prevent context bloat.
 */

import chalk from 'chalk';
import * as dns from 'dns';
import { promisify } from 'util';
const lookup = promisify(dns.lookup);
// resolve4/resolve6 are used inline in isSafeUrl via promisify(dns.resolve4/6)

export interface WebBlock {
  type: 'search' | 'url';
  value: string;
}

export interface WebResult {
  type: 'search' | 'url';
  value: string;
  success: boolean;
  output: string;
}

// ─── Parsers ──────────────────────────────────────────────────────────────

export function parseWebBlocks(response: string): WebBlock[] {
  const blocks: WebBlock[] = [];
  
  // Match ```search ... ```
  const searchRegex = /```search\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = searchRegex.exec(response)) !== null) {
    const lines = (match[1] || '').split('\n');
    const queryLine = lines.find((l: string) => l.toLowerCase().startsWith('query:'));
    if (queryLine) {
      blocks.push({ type: 'search', value: queryLine.substring(6).trim() });
    } else if (match[1]) {
      // Fallback: use the whole block as query
      blocks.push({ type: 'search', value: match[1].trim() });
    }
  }

  // Match ```url ... ```
  const urlRegex = /```url\n([\s\S]*?)```/gi;
  while ((match = urlRegex.exec(response)) !== null) {
    const lines = (match[1] || '').split('\n');
    const urlLine = lines.find((l: string) => l.toLowerCase().startsWith('url:'));
    if (urlLine) {
      blocks.push({ type: 'url', value: urlLine.substring(4).trim() });
    } else if (match[1]) {
      // Fallback: use the whole block as URL
      blocks.push({ type: 'url', value: match[1].trim() });
    }
  }

  return blocks;
}

// ─── Security ─────────────────────────────────────────────────────────────

/**
 * Returns true if the given IP address is a private/reserved/non-routable address.
 * Covers:
 *  - IPv4 loopback (127.x.x.x)
 *  - IPv4 private ranges (10.x, 172.16-31.x, 192.168.x)
 *  - IPv4 link-local & cloud metadata (169.254.x.x — AWS/GCP/Azure IMDS)
 *  - Bind-all (0.0.0.0)
 *  - IPv6 loopback (::1)
 *  - IPv6 link-local (fe80::/10)
 *  - IPv4-mapped IPv6 (::ffff:127.x.x.x, etc.)
 */
function isPrivateIp(ip: string): boolean {
  // Strip IPv6 zone ID (e.g. fe80::1%eth0)
  const addr = ip.split('%')[0]!.toLowerCase();

  // ── IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:0a00:0000) ─────────────
  if (addr.startsWith('::ffff:')) {
    const v4part = addr.slice(7);
    // Could be dotted-decimal or hex groups
    if (v4part.includes('.')) {
      return isPrivateIp(v4part);
    }
    // Hex notation - YAGNI, URL() normalizes these.
    return false;
  }

  // ── IPv6 checks ────────────────────────────────────────────────────────
  if (addr.includes(':')) {
    if (addr === '::1') return true;                         // loopback
    if (addr.startsWith('fe80:') || addr.startsWith('fe8') ||
        addr.startsWith('fe9') || addr.startsWith('fea') ||
        addr.startsWith('feb')) return true;                 // link-local fe80::/10
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // ULA fc00::/7
    return false;
  }

  // ── IPv4 checks ────────────────────────────────────────────────────────
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return true; // malformed → block

  const [a, b] = parts as [number, number, number, number];

  if (a === 0)   return true;                          // 0.0.0.0/8  — bind-all
  if (a === 10)  return true;                          // 10.0.0.0/8
  if (a === 127) return true;                          // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 — link-local / IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 — carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24 — TEST-NET
  if (a >= 224) return true;                           // 224+ — multicast / reserved

  return false;
}

/**
 * Prevents SSRF by resolving ALL addresses for the hostname and checking
 * every one against the private-IP blocklist.
 *
 * Security properties:
 * - Rejects non-HTTP(S) protocols
 * - Rejects localhost by name
 * - Resolves hostname to ALL IP addresses (dns.resolve4 + resolve6) and
 *   blocks if ANY address is private (multi-A-record attack mitigation)
 * - Falls back to dns.lookup (OS resolver) if resolve4/6 return nothing
 * - Returns false (block) on any error — fail-safe
 */
async function isSafeUrl(targetUrl: string): Promise<boolean> {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname.toLowerCase();

    // Reject obviously private hostnames by name
    if (hostname === 'localhost' || hostname === 'ip6-localhost' || hostname === 'ip6-loopback') {
      return false;
    }
    // Reject numeric IP directly in URL (no DNS needed)
    if (isPrivateIp(hostname)) return false;

    // Resolve ALL A (IPv4) and AAAA (IPv6) records — block if any are private
    const resolve4Async = promisify(dns.resolve4);
    const resolve6Async = promisify(dns.resolve6);

    const v4Addrs: string[] = await resolve4Async(hostname).catch(() => []);
    const v6Addrs: string[] = await resolve6Async(hostname).catch(() => []);
    const allAddrs = [...v4Addrs, ...v6Addrs];

    // If multi-resolution returned nothing, fall back to OS resolver (single address)
    if (allAddrs.length === 0) {
      const res = await lookup(hostname);
      allAddrs.push(res.address);
    }

    // Block if ANY resolved address is private
    if (allAddrs.some(isPrivateIp)) return false;

    return allAddrs.length > 0; // block if we got no address at all
  } catch {
    return false; // fail-safe: unknown error → block
  }
}

// ─── Execution ────────────────────────────────────────────────────────────

async function executeSearch(query: string): Promise<string> {
  const provider = process.env.WEB_SEARCH_PROVIDER?.toLowerCase() || 'tavily';
  const apiKey = process.env.WEB_SEARCH_API_KEY;

  try {
    if (provider === 'tavily' && apiKey) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, include_answer: false, max_results: 5 }),
      });
      if (!res.ok) throw new Error(`Tavily API returned ${res.status}`);
      const data = await res.json() as any;
      if (!data.results || !Array.isArray(data.results)) return 'No results.';
      return JSON.stringify(data.results.map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.content
      })), null, 2);
    } 
    
    // Fallback: Brave Search API
    if (provider === 'brave' && apiKey) {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey }
      });
      if (!res.ok) throw new Error(`Brave API returned ${res.status}`);
      const data = await res.json() as any;
      if (!data.web || !data.web.results) return 'No results.';
      return JSON.stringify(data.web.results.map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.description
      })), null, 2);
    }

    // Default Fallback: Open-source DuckDuckGo HTML scraper (no API key needed)
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
    });
    const html = await res.text();
    
    // Ultra-lightweight regex scraping for DDG HTML
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const resultBlocks = html.split('class="result__body"').slice(1, 6);
    
    for (const block of resultBlocks) {
      const titleMatch = block.match(/<a class="result__url" href="([^"]+)".*?>([^<]+)<\/a>/);
      const snippetMatch = block.match(/<a class="result__snippet[^>]+>(.*?)<\/a>/);
      if (titleMatch && snippetMatch && titleMatch[1] && titleMatch[2] && snippetMatch[1]) {
        // Unescape DDG redirect URL
        let url = titleMatch[1];
        if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
          const splitUddg = url.split('uddg=')[1];
          if (splitUddg) {
             const firstParam = splitUddg.split('&')[0];
             if (firstParam) url = decodeURIComponent(firstParam);
          }
        }
        results.push({
          title: titleMatch[2].trim(),
          url,
          snippet: snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, '').trim() // strip remaining tags
        });
      }
    }
    
    if (results.length === 0) return 'No results found.';
    return JSON.stringify(results, null, 2);

  } catch (err: any) {
    return `Search failed: ${err.message}`;
  }
}

async function executeUrl(url: string): Promise<string> {
  if (!(await isSafeUrl(url))) {
    return 'URL blocked: Invalid or unsafe destination (SSRF protection).';
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Laila-Agent/1.0' },
      // Abort after 5 seconds to prevent hanging
      signal: AbortSignal.timeout(5000)
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    let html = await res.text();
    
    // Aggressive sanitization: remove scripts, styles, and SVG
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
    html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
    html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
    
    // Strip all HTML tags
    let text = html.replace(/<\/?[^>]+(>|$)/g, ' ');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    // Truncate to avoid context bloat (approx 4000 chars)
    if (text.length > 4000) {
      text = text.slice(0, 4000) + '\n\n[... Content truncated due to length ...]';
    }
    
    return text || 'No readable text found on page.';
  } catch (err: any) {
    return `Failed to read URL: ${err.message}`;
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────

export async function runWebBlocks(response: string): Promise<{ webContext: string; hasResults: boolean }> {
  const blocks = parseWebBlocks(response);
  if (blocks.length === 0) return { webContext: '', hasResults: false };

  const results: WebResult[] = [];
  
  for (const block of blocks) {
    let output = '';
    let success = true;
    
    if (block.type === 'search') {
      console.log(chalk.dim(`  🔍 Searching web for: "${block.value}"`));
      output = await executeSearch(block.value);
      success = !output.startsWith('Search failed:');
    } else if (block.type === 'url') {
      console.log(chalk.dim(`  🌐 Reading webpage: ${block.value}`));
      output = await executeUrl(block.value);
      success = !output.startsWith('Failed to read URL:') && !output.startsWith('URL blocked:');
    }

    results.push({ type: block.type, value: block.value, success, output });
    
    const icon = success ? chalk.green('✔') : chalk.red('✗');
    const firstLine = output.split('\n')[0] || '';
    console.log(`  ${icon} ${block.type}: ${success ? 'Success' : firstLine}`);
  }

  // Format for follow-up prompt
  const parts = ['=== Web & Search Results ==='];
  for (const r of results) {
    const actionStr = r.type === 'search' ? `Search Query: ${r.value}` : `URL Read: ${r.value}`;
    parts.push(`\n---\n${actionStr}\nResult:\n${r.output}`);
  }
  
  parts.push('\nIMPORTANT INSTRUCTIONS:');
  parts.push('1. Read the above search results or webpage contents.');
  parts.push('2. Answer the user\'s question based on this new information.');
  parts.push('3. YOU MUST INCLUDE CITATIONS for any claims made using the format [Source Name](URL).');
  parts.push('4. If the results do not contain the answer, you may issue another ```search or ```url block to dig deeper, or tell the user the information cannot be verified.');

  return { webContext: parts.join('\n'), hasResults: true };
}
