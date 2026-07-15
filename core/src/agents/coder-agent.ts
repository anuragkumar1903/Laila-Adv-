import { BaseAgent } from './base-agent.js';
import { buildMessages } from '../llm/prompt-builder.js';
import { chat } from '../llm/provider-factory.js';
import type { AgentContext, AgentResponse } from '../types.js';

export class CoderAgent extends BaseAgent {
  readonly name = 'coder';

  override async run(ctx: AgentContext): Promise<AgentResponse> {
    // Inject a coding-specific instruction into the user message
    const enrichedCtx: AgentContext = {
      ...ctx,
      userMessage:
        `${ctx.userMessage}\n\n` +
        `[Instructions]\n` +
        `- Respond with complete, working code only.\n` +
        `- Use the project's existing conventions, framework, and language.\n` +
        `- When you modify code, output the full modified file inside a markdown code block.\n` +
        `- The very first line inside the code block MUST be EXACTLY: // FILE: <path/to/file.ext>\n` +
        `- Add brief inline comments where non-obvious.\n` +
        `- Do NOT explain the code unless asked.\n` +
        `\n` +
        `[Shell Commands]\n` +
        `- If you need to run a shell command (e.g. install a package, run a build, execute a script), ` +
        `wrap it in a \`\`\`cmd block — NOT inside a code file block.\n` +
        `- Format:\n` +
        `  \`\`\`cmd\n` +
        `  # Brief reason for this command\n` +
        `  <the command>\n` +
        `  \`\`\`\n` +
        `- Propose ONE command at a time. The user will be asked to approve before it runs.\n` +
        `- After the command runs, its output will be provided so you can continue.\n` +
        `- NEVER propose commands that delete files, modify system settings, or require elevated privileges.\n` +
        `- Only propose commands from: npm, npx, pnpm, yarn, node, tsc, git, python, pip, go, cargo, dotnet, make, ` +
        `powershell, pwsh, cmd built-ins (dir, copy, move, mkdir, type, findstr, tree), ` +
        `PowerShell cmdlets (Get-*, New-*, Copy-*, Move-*, Test-*, Write-*, Select-*, Sort-*, Format-*), ` +
        `and Unix utilities (ls, cat, grep, find, curl, tar, diff, sed, awk).`,
    };

    const messages = buildMessages(enrichedCtx);
    const result   = await chat(messages, { temperature: 0.1 }); // low temp for determinism
    return { content: result.content, tokensUsed: result.tokensUsed };
  }
}
