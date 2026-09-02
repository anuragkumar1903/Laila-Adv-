import type { Interface } from 'readline';

/**
 * Asks a question via readline with built-in ESC key cancellation.
 * If ESC is pressed, it aborts the prompt and resolves with cancelValue.
 */
export async function askQuestion(
  rl: Interface,
  prompt: string,
  cancelValue: string = ''
): Promise<string> {
  return new Promise<string>(resolve => {
    const ac = new AbortController();
    const onEsc = (_str: string, key: any) => {
      if (key && key.name === 'escape') {
        ac.abort();
        process.stdin.removeListener('keypress', onEsc);
        console.log();
        resolve(cancelValue);
      }
    };
    process.stdin.on('keypress', onEsc);
    
    rl.question(prompt, { signal: ac.signal }, answer => {
      process.stdin.removeListener('keypress', onEsc);
      resolve(answer.trim());
    });
  }).catch(() => cancelValue);
}

/**
 * Convenience wrapper for Yes/No questions.
 * Pressing ESC automatically resolves to `false` (No).
 */
export async function askYesNo(
  rl: Interface,
  prompt: string,
  defaultYes: boolean = true
): Promise<boolean> {
  // We use a special string to detect ESC vs empty Enter
  const answer = await askQuestion(rl, prompt, '__ESC__');
  if (answer === '__ESC__') return false; // ESC means cancel/no
  
  if (!answer) return defaultYes; // Enter uses default
  const lower = answer.toLowerCase();
  return lower === 'y' || lower === 'yes';
}
