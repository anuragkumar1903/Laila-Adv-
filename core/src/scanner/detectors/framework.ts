import type { FileCategory } from '../../types.js';

// ── Node.js package.json framework detection ──────────────────────────────

const DEP_FRAMEWORK_MAP: Array<[dep: string, framework: string]> = [
  ['@nestjs/core',        'NestJS'],
  ['next',                'Next.js'],
  ['nuxt',                'Nuxt.js'],
  ['@sveltejs/kit',       'SvelteKit'],
  ['@remix-run/node',     'Remix'],
  ['astro',               'Astro'],
  ['fastify',             'Fastify'],
  ['express',             'Express.js'],
  ['koa',                 'Koa'],
  ['hono',                'Hono'],
  ['elysia',              'Elysia'],
  ['@angular/core',       'Angular'],
  ['react',               'React'],
  ['vue',                 'Vue.js'],
  ['svelte',              'Svelte'],
  ['solid-js',            'SolidJS'],
  ['gatsby',              'Gatsby'],
  ['electron',            'Electron'],
  ['@trpc/server',        'tRPC'],
  ['graphql',             'GraphQL'],
  ['@prisma/client',      'Prisma'],
  ['drizzle-orm',         'Drizzle'],
  ['typeorm',             'TypeORM'],
  ['mongoose',            'Mongoose'],
  ['sequelize',           'Sequelize'],
];

type PkgJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export function detectFrameworkFromPkg(pkg: PkgJson): string | null {
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  for (const [dep, framework] of DEP_FRAMEWORK_MAP) {
    if (dep in allDeps) return framework;
  }
  return null;
}

// ── File-based detection for non-Node projects ────────────────────────────

const FILE_MARKERS: Array<[file: string, framework: string]> = [
  ['manage.py',         'Django'],
  ['settings.py',       'Django'],
  ['requirements.txt',  'Python'],
  ['Pipfile',           'Python/Pipenv'],
  ['pyproject.toml',    'Python'],
  ['go.mod',            'Go'],
  ['Cargo.toml',        'Rust/Cargo'],
  ['pom.xml',           'Java/Maven'],
  ['build.gradle',      'Java/Gradle'],
  ['build.gradle.kts',  'Kotlin/Gradle'],
  ['Gemfile',           'Ruby/Rails'],
  ['composer.json',     'PHP/Composer'],
  ['pubspec.yaml',      'Dart/Flutter'],
  ['mix.exs',           'Elixir'],
];

export function detectFrameworkFromFiles(fileNames: string[]): string | null {
  const set = new Set(fileNames.map(f => f.split('/').at(-1) ?? f));
  for (const [marker, framework] of FILE_MARKERS) {
    if (set.has(marker)) return framework;
  }
  return null;
}
