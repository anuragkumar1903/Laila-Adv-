import { pathExists } from '../../utils/fs-utils.js';
import path from 'path';

type PkgManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'pip' | 'pipenv' | 'poetry' | 'cargo' | 'go' | 'maven' | 'gradle' | 'unknown';

const LOCK_FILES: Array<[file: string, manager: PkgManager]> = [
  ['bun.lockb',          'bun'],
  ['pnpm-lock.yaml',     'pnpm'],
  ['yarn.lock',          'yarn'],
  ['package-lock.json',  'npm'],
  ['Pipfile.lock',       'pipenv'],
  ['poetry.lock',        'poetry'],
  ['Cargo.lock',         'cargo'],
  ['go.sum',             'go'],
];

const CONFIG_FILES: Array<[file: string, manager: PkgManager]> = [
  ['Pipfile',            'pipenv'],
  ['pyproject.toml',     'poetry'],
  ['requirements.txt',   'pip'],
  ['Cargo.toml',         'cargo'],
  ['go.mod',             'go'],
  ['pom.xml',            'maven'],
  ['build.gradle',       'gradle'],
  ['build.gradle.kts',   'gradle'],
];

export async function detectPackageManager(projectRoot: string): Promise<PkgManager> {
  // Lock files are definitive
  for (const [file, manager] of LOCK_FILES) {
    if (await pathExists(path.join(projectRoot, file))) return manager;
  }
  // Fall back to config files
  for (const [file, manager] of CONFIG_FILES) {
    if (await pathExists(path.join(projectRoot, file))) return manager;
  }
  return 'unknown';
}
