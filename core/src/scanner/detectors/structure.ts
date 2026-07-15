import path from 'path';
import type { FileCategory } from '../../types.js';

// ── Directory name heuristics ─────────────────────────────────────────────
const DIR_CATEGORY_MAP: Record<string, FileCategory> = {
  controllers: 'controller', controller: 'controller',
  handlers:    'controller', resolvers: 'controller',
  services:    'service',    service:   'service',
  providers:   'service',    usecases:  'service',
  routes:      'route',      routers:   'route', routing: 'route',
  models:      'model',      entities:  'model', domain: 'model',
  schemas:     'schema',     schema:    'schema',
  middleware:  'middleware',  middlewares: 'middleware',
  guards:      'middleware',  pipes:     'middleware', interceptors: 'middleware',
  utils:       'util',        helpers:   'util', lib: 'util', shared: 'util',
  tests:       'test',        test:      'test', spec: 'test', __tests__: 'test',
  config:      'config',      configs:   'config', configuration: 'config',
  migrations:  'schema',      seeds:     'schema',
};

// ── File name suffix heuristics ───────────────────────────────────────────
const SUFFIX_CATEGORY_MAP: Array<[suffix: string, category: FileCategory]> = [
  ['.controller',  'controller'],
  ['.handler',     'controller'],
  ['.resolver',    'controller'],
  ['.service',     'service'],
  ['.provider',    'service'],
  ['.usecase',     'service'],
  ['.use-case',    'service'],
  ['.router',      'route'],
  ['.routes',      'route'],
  ['.route',       'route'],
  ['.model',       'model'],
  ['.entity',      'model'],
  ['.dto',         'model'],
  ['.schema',      'schema'],
  ['.migration',   'schema'],
  ['.middleware',  'middleware'],
  ['.guard',       'middleware'],
  ['.pipe',        'middleware'],
  ['.interceptor', 'middleware'],
  ['.util',        'util'],
  ['.helper',      'util'],
  ['.spec',        'test'],
  ['.test',        'test'],
  ['.e2e',         'test'],
  ['.e2e-spec',    'test'],
  ['.config',      'config'],
  ['.conf',        'config'],
];

const CONFIG_FILENAMES = new Set([
  'tsconfig.json', 'jsconfig.json', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', 'prettier.config.js', 'vite.config.ts', 'vite.config.js',
  'next.config.js', 'next.config.ts', 'nest-cli.json', '.env', '.env.example',
  'docker-compose.yml', 'Dockerfile', '.gitignore', '.gitattributes',
  'jest.config.ts', 'jest.config.js', 'vitest.config.ts', 'babel.config.js',
  'webpack.config.js', 'rollup.config.js', 'package.json', 'Makefile',
]);

export function categoriseFile(relPath: string): FileCategory {
  const filename = path.basename(relPath);
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length).toLowerCase();  // stem without extension
  const parts = relPath.split(/[/\\]/);

  // 1. Known config filenames
  if (CONFIG_FILENAMES.has(filename)) return 'config';

  // 2. Directory name match (walk upward)
  for (let i = parts.length - 2; i >= 0; i--) {
    const dir = (parts[i] ?? '').toLowerCase();
    const cat = DIR_CATEGORY_MAP[dir];
    if (cat) return cat;
  }

  // 3. File suffix match (e.g. `user.service.ts`)
  for (const [suffix, cat] of SUFFIX_CATEGORY_MAP) {
    if (base.endsWith(suffix)) return cat;
  }

  return 'other';
}
