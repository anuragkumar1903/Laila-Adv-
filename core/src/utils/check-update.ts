import { readFileSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

export async function checkForUpdates(): Promise<void> {
  try {
    // Read local package.json
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const pkgData = readFileSync(pkgUrl, 'utf-8');
    const pkg = JSON.parse(pkgData);
    
    // Don't check if we haven't renamed from default "laila" yet
    if (pkg.name === 'laila' || pkg.private) return;

    // Fetch latest version from NPM registry silently (max 2 seconds)
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(2000)
    });
    
    if (res.ok) {
      const latest = (await res.json()) as any;
      if (latest.version && latest.version !== pkg.version) {
        console.log('');
        console.log(chalk.yellow(`  ──────────────────────────────────────────────────────────`));
        console.log(chalk.yellow(`   🌟 Update available: ${chalk.white(pkg.version)} → ${chalk.green.bold(latest.version)}`));
        console.log(chalk.yellow('   Run ') + chalk.cyan(`npm install -g ${pkg.name}`) + chalk.yellow(' to update Laila!'));
        console.log(chalk.yellow(`  ──────────────────────────────────────────────────────────`));
        console.log('');
      }
    }
  } catch (err) {
    // Fail silently in background if offline or registry is down
  }
}
