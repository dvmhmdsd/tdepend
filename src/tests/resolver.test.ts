import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SKIPS, collectFiles } from '../files/collectFiles';
import { parseFile } from '../parser/extractSites';
import { discoverProject } from '../project/discoverProject';
import type { ProjectContext } from '../project/types';
import { createResolver } from '../resolver/createResolver';
import type { Resolution, ResolveOptions, Resolver } from '../resolver/types';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

interface Harness {
  root: string;
  ctx: ProjectContext;
  resolver: Resolver;
  files: Set<string>;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-resolver-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function harness(name: string, options: Partial<ResolveOptions> = {}): Harness {
  const root = name.startsWith('/') ? name : join(FIXTURES, name);
  const ctx = discoverProject(root);
  const collected = collectFiles(ctx, {
    include: [],
    exclude: [],
    presetSkips: DEFAULT_SKIPS,
  });
  const resolver = createResolver(ctx, new Set(collected.files), {
    aliases: {},
    virtual: [],
    ignoreUnresolved: [],
    ...options,
  });
  return { root, ctx, resolver, files: new Set(collected.files) };
}

function siteOf(harness: Harness, file: string, code: string, specifier: string) {
  const { options } = harness.ctx.optionsFor(file);
  const parsed = parseFile(file, code, options, join(harness.root, file));
  const site = parsed.sites.find((candidate) => candidate.specifier === specifier);
  if (site === undefined) throw new Error(`no site "${specifier}" in ${file}`);
  return { parsed, site };
}

function resolveCode(harness: Harness, file: string, code: string, specifier: string): Resolution {
  const { parsed, site } = siteOf(harness, file, code, specifier);
  return harness.resolver.resolve(site, parsed);
}

function resolveInFile(harness: Harness, file: string, specifier: string): Resolution {
  const code = readFileSync(join(harness.root, file), 'utf-8');
  return resolveCode(harness, file, code, specifier);
}

describe('resolver relative and path resolution', () => {
  it('resolves a CommonJS relative import to its source file', () => {
    const h = harness('nest-cjs');

    expect(resolveInFile(h, 'src/user.controller.ts', './user.service')).toEqual({
      class: 'internal',
      target: { file: 'src/user.service.ts' },
    });
  });

  it('resolves a NodeNext .js specifier to the .ts source', () => {
    const h = harness('nest-nodenext');

    expect(resolveInFile(h, 'src/user.controller.ts', './users/user.service.js')).toMatchObject({
      class: 'internal',
      target: { file: 'src/users/user.service.ts' },
    });
  });

  it('resolves a tsconfig paths alias and a directory index', () => {
    const h = harness('vite-tanstack-router');

    expect(resolveInFile(h, 'src/main.tsx', '@/components/button')).toMatchObject({
      class: 'internal',
      target: { file: 'src/components/button.tsx' },
    });
    expect(resolveInFile(h, 'src/main.tsx', './features/cart')).toMatchObject({
      class: 'internal',
      target: { file: 'src/features/cart/index.ts' },
    });
  });

  it('resolves a paths-mapped package name inside a monorepo', () => {
    const h = harness('nest-monorepo-paths');

    expect(resolveInFile(h, 'src/user.service.ts', '@app/common')).toMatchObject({
      class: 'internal',
      target: { file: 'libs/common/src/index.ts' },
    });
  });

  it('resolves an alias prefix map after TypeScript fails, and never calls it external', () => {
    const h = harness('vite-tanstack-router', { aliases: { '~/': 'src/' } });

    expect(
      resolveCode(h, 'src/main.tsx', "import '~/components/button';", '~/components/button'),
    ).toMatchObject({ class: 'internal', target: { file: 'src/components/button.tsx' } });

    const missing = resolveCode(h, 'src/main.tsx', "import '~/nope';", '~/nope');
    expect(missing.class).toBe('unresolved');
  });

  it('keeps an alias-looking package name out of the external class', () => {
    const h = harness('vite-tanstack-router', { aliases: { '@acme/': 'src/' } });

    expect(resolveCode(h, 'src/main.tsx', "import '@acme/nope';", '@acme/nope').class).toBe(
      'unresolved',
    );
  });
});

describe('resolver alias precedence', () => {
  it('lets the longest matching prefix win regardless of key order', () => {
    const first = harness('vite-tanstack-router', {
      aliases: { '~/': 'src/', '~/components/': 'lib/' },
    });
    expect(
      resolveCode(first, 'src/main.tsx', "import '~/components/button';", '~/components/button'),
    ).toMatchObject({ class: 'internal', target: { file: 'lib/button.ts' } });

    const reversed = harness('vite-tanstack-router', {
      aliases: { '~/components/': 'lib/', '~/': 'src/' },
    });
    expect(
      resolveCode(reversed, 'src/main.tsx', "import '~/components/button';", '~/components/button'),
    ).toMatchObject({ class: 'internal', target: { file: 'lib/button.ts' } });
  });

  it('keeps successful TypeScript resolution ahead of a conflicting custom alias', () => {
    const h = harness('vite-tanstack-router', { aliases: { '@/': 'lib/' } });

    expect(
      resolveCode(h, 'src/main.tsx', "import '@/components/button';", '@/components/button'),
    ).toMatchObject({ class: 'internal', target: { file: 'src/components/button.tsx' } });
  });
});

describe('resolver classification order', () => {
  it('shares the module identity node:fs between fs and node:fs', () => {
    const h = harness('vite-tanstack-router');

    expect(resolveCode(h, 'src/main.tsx', "import f from 'fs';", 'fs')).toEqual({
      class: 'builtin',
      target: { module: 'node:fs' },
    });
    expect(resolveCode(h, 'src/main.tsx', "import f from 'node:fs';", 'node:fs')).toEqual({
      class: 'builtin',
      target: { module: 'node:fs' },
    });
  });

  it('classes stylesheets, queries and virtual modules before resolving them', () => {
    const h = harness('vite-tanstack-router');

    expect(resolveInFile(h, 'src/main.tsx', './styles.css')).toEqual({
      class: 'asset',
      target: null,
    });
    expect(resolveInFile(h, 'src/main.tsx', './logo.svg?react')).toEqual({
      class: 'asset',
      target: null,
    });
    expect(resolveInFile(h, 'src/main.tsx', 'virtual:pwa-register')).toEqual({
      class: 'virtual',
      target: null,
    });
  });

  it('honours the virtual patterns from the resolve options', () => {
    const h = harness('vite-tanstack-router', { virtual: ['virtual:*'] });

    expect(resolveInFile(h, 'src/main.tsx', 'virtual:pwa-register').class).toBe('virtual');
  });

  it('reports an undeclared bare specifier as unresolved and a declared one as not-installed', () => {
    const h = harness('vite-tanstack-router');

    expect(resolveInFile(h, 'src/main.tsx', 'left-pad')).toEqual({
      class: 'unresolved',
      target: null,
    });
    expect(resolveCode(h, 'src/main.tsx', "import react from 'react';", 'react')).toEqual({
      class: 'external',
      target: { module: 'react' },
      reason: 'not-installed',
    });
  });

  it('reports a missing relative target as unresolved and an excluded existing file as excluded', () => {
    const h = harness('vite-tanstack-router');

    expect(resolveInFile(h, 'src/main.tsx', './missing')).toEqual({
      class: 'unresolved',
      target: null,
    });
    expect(resolveInFile(h, 'src/main.tsx', './x.spec')).toMatchObject({
      class: 'excluded',
      target: { file: 'src/x.spec.ts' },
    });
    expect(h.files.has('src/x.spec.ts')).toBe(false);
  });

  it('reports a gitignored missing target as ignored with reason gitignored', () => {
    const h = harness('nest-nodenext');

    expect(
      resolveInFile(h, 'src/users/user.repository.ts', '../generated/prisma/client.js'),
    ).toEqual({ class: 'ignored', target: null, reason: 'gitignored' });
  });

  it('matches a gitignored target through an extensionless specifier', () => {
    const h = harness('vite-tanstack-router-missing-gen');

    expect(resolveInFile(h, 'src/main.tsx', './routeTree.gen')).toEqual({
      class: 'ignored',
      target: null,
      reason: 'gitignored',
    });
  });

  it('a present but gitignored target is excluded, with its file', () => {
    const h = harness('vite-tanstack-router');

    expect(resolveInFile(h, 'src/main.tsx', './routeTree.gen')).toMatchObject({
      class: 'excluded',
      target: { file: 'src/routeTree.gen.ts' },
    });
  });

  it('reports a relative specifier matching ignoreUnresolved as ignored', () => {
    const h = harness('vite-tanstack-router-missing-gen', {
      ignoreUnresolved: ['**/routeTree.gen'],
    });

    expect(resolveInFile(h, 'src/main.tsx', './routeTree.gen')).toEqual({
      class: 'ignored',
      target: null,
      reason: 'ignore-unresolved',
    });
  });
});

describe('resolver virtual and asset precedence', () => {
  it('classifies a virtual name before an asset extension or query', () => {
    const h = harness('vite-tanstack-router');

    expect(
      resolveCode(h, 'src/main.tsx', "import '~icons/mdi/home.svg';", '~icons/mdi/home.svg'),
    ).toEqual({ class: 'virtual', target: null });
    expect(
      resolveCode(h, 'src/main.tsx', "import 'virtual:styles.css';", 'virtual:styles.css'),
    ).toEqual({ class: 'virtual', target: null });
    expect(resolveInFile(h, 'src/main.tsx', './styles.css')).toEqual({
      class: 'asset',
      target: null,
    });
    expect(resolveInFile(h, 'src/main.tsx', './logo.svg?react')).toEqual({
      class: 'asset',
      target: null,
    });
  });

  it('lets a configured virtual pattern win over an asset extension', () => {
    const h = harness('vite-tanstack-router', { virtual: ['**/*.css'] });

    expect(
      resolveCode(h, 'src/main.tsx', "import 'assets/styles.css';", 'assets/styles.css'),
    ).toEqual({ class: 'virtual', target: null });
  });

  it('keeps builtins ahead of a broad virtual pattern', () => {
    const h = harness('vite-tanstack-router', { virtual: ['**'] });

    expect(resolveInFile(h, 'src/main.tsx', 'node:fs')).toEqual({
      class: 'builtin',
      target: { module: 'node:fs' },
    });
  });
});

describe('resolver workspace packages', () => {
  it('maps a bare workspace import through the built declaration file', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'packages/a/src/index.ts', '@demo/b')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/b/src/index.ts' },
      mapped: { from: 'packages/b/dist/index.d.ts' },
      requested: { package: '@demo/b', subpath: '.' },
    });
  });

  it('gives identical resolutions for the built and unbuilt copies of a workspace', () => {
    const built = harness('pnpm-monorepo');
    const unbuilt = harness('pnpm-monorepo-unbuilt');

    const probes: Array<[string, string]> = [
      ['packages/a/src/index.ts', '@demo/b'],
      ['packages/a/src/esm.mts', '@demo/b/import-only'],
      ['packages/a/src/esm.mts', '@demo/cond'],
      ['packages/a/src/conditions.ts', '@demo/cond/node-default-null'],
      ['packages/a/src/conditions.ts', '@demo/cond/default-first'],
      ['packages/a/src/conditions.ts', '@demo/cond/default-null-node'],
      ['packages/esm/src/index.ts', '@demo/cond'],
      ['scripts/seed.ts', '@demo/b'],
    ];

    for (const [file, specifier] of probes) {
      expect(resolveInFile(unbuilt, file, specifier)).toEqual(
        resolveInFile(built, file, specifier),
      );
    }
  });

  it('records the workspace request before resolution, including the bare subpath', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'packages/a/src/undeclared.ts', '@demo/b/src/internal')).toMatchObject({
      class: 'unresolved',
      requested: { package: '@demo/b', subpath: './src/internal' },
    });
    expect(resolveInFile(h, 'packages/a/src/blocked.ts', '@demo/b/blocked')).toMatchObject({
      class: 'unresolved',
      requested: { package: '@demo/b', subpath: './blocked' },
    });
  });

  it('sets the requested subpath to "." for a bare workspace import', () => {
    const h = harness('pnpm-monorepo');
    const { parsed, site } = siteOf(
      h,
      'packages/a/src/index.ts',
      "import { b } from '@demo/cond';",
      '@demo/cond',
    );
    const resolution = h.resolver.resolve(site, parsed);

    expect(resolution.requested).toEqual({ package: '@demo/cond', subpath: '.' });
  });

  it('never falls back to the package index for a blocked subpath', () => {
    const h = harness('pnpm-monorepo');

    const resolution = resolveInFile(h, 'packages/a/src/blocked.ts', '@demo/b/blocked');
    expect(resolution.target).toBeNull();
  });

  it('resolves an import-only subpath from an ESM site and blocks it from a require site', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'packages/a/src/esm.mts', '@demo/b/import-only')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/b/src/import-only.ts' },
    });
    expect(resolveInFile(h, 'packages/a/src/require.cts', '@demo/b/import-only')).toMatchObject({
      class: 'unresolved',
      requested: { package: '@demo/b', subpath: './import-only' },
    });
  });

  it('classes an import from the workspace root into a package as workspace', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'scripts/seed.ts', '@demo/b')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/b/src/index.ts' },
    });
    expect(resolveInFile(h, 'scripts/seed.ts', './util')).toMatchObject({ class: 'internal' });
  });

  it('records the workspace request on asset and virtual sites too', () => {
    const h = harness('pnpm-monorepo');

    expect(
      resolveCode(h, 'packages/a/src/index.ts', "import '@demo/b/logo.svg';", '@demo/b/logo.svg'),
    ).toEqual({
      class: 'asset',
      target: null,
      requested: { package: '@demo/b', subpath: './logo.svg' },
    });
  });

  it('never classes a workspace specifier as external', () => {
    const h = harness('pnpm-monorepo');

    const { parsed, site } = siteOf(
      h,
      'packages/a/src/index.ts',
      "import { b } from '@demo/b';",
      '@demo/b',
    );
    const resolution = h.resolver.resolve(site, parsed);

    expect(resolution.class).not.toBe('external');
    expect(h.ctx.projectFor('packages/a/src/index.ts').dependencies.has('@demo/b')).toBe(true);
  });
});

describe('resolver conditions and resolution mode', () => {
  it('takes the resolution mode from the usage location, so import = require is CommonJS', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'packages/a/src/mode.mts', '@demo/cond')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/cond/src/cjs.ts' },
    });
    expect(resolveInFile(h, 'packages/a/src/esm.mts', '@demo/cond')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/cond/src/esm.ts' },
    });
  });

  it('a .ts file in a "type": "module" package resolves with the import condition', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'packages/esm/src/index.ts', '@demo/cond')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/cond/src/esm.ts' },
    });
    expect(
      resolveCode(h, 'packages/a/src/index.ts', "import { x } from '@demo/cond';", '@demo/cond'),
    ).toMatchObject({ target: { file: 'packages/cond/src/cjs.ts' } });
  });

  it('skips a null default condition that comes first and continues to node', () => {
    const h = harness('pnpm-monorepo');

    expect(
      resolveInFile(h, 'packages/a/src/conditions.ts', '@demo/cond/default-null-node'),
    ).toMatchObject({ class: 'workspace', target: { file: 'packages/cond/src/node.ts' } });
  });

  it('matches the node condition under NodeNext and is blocked when only default is left', () => {
    const h = harness('pnpm-monorepo');

    expect(
      resolveInFile(h, 'packages/a/src/conditions.ts', '@demo/cond/node-default-null'),
    ).toMatchObject({ class: 'workspace', target: { file: 'packages/cond/src/node.ts' } });
  });

  it('walks conditional keys in their original order', () => {
    const h = harness('pnpm-monorepo');

    expect(
      resolveInFile(h, 'packages/a/src/conditions.ts', '@demo/cond/default-first'),
    ).toMatchObject({ class: 'workspace', target: { file: 'packages/cond/src/a.ts' } });
  });

  it('exposes a custom condition only when customConditions lists it', () => {
    const h = harness('pnpm-monorepo');

    expect(resolveInFile(h, 'packages/a/browser/entry.ts', '@demo/cond/browser')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/cond/src/browser.ts' },
    });
    expect(
      resolveInFile(h, 'packages/a/browser/entry.ts', '@demo/cond/node-default-null'),
    ).toMatchObject({ class: 'unresolved' });
  });
});

describe('resolver source mapping', () => {
  it('maps a declaration target through declarationDir and a non-src rootDir', () => {
    const h = harness('pnpm-monorepo-declaration-dir');

    expect(resolveInFile(h, 'packages/app/lib/consumer.ts', '@demo/lib')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/lib/lib/index.ts' },
      mapped: { from: 'packages/lib/types/index.d.ts' },
    });
  });

  it('reports two source candidates as an ambiguous mapping', () => {
    const h = harness('pnpm-monorepo-declaration-dir');

    expect(resolveInFile(h, 'packages/app/lib/consumer.ts', '@demo/ambig')).toMatchObject({
      class: 'unresolved',
      reason: 'ambiguous-source-mapping',
    });
  });

  it('reports a module-only package as having no resolvable entry', () => {
    const h = harness('pnpm-monorepo-declaration-dir');

    expect(resolveInFile(h, 'packages/app/lib/consumer.ts', '@demo/mod')).toMatchObject({
      class: 'unresolved',
      reason: 'no-resolvable-entry',
      requested: { package: '@demo/mod', subpath: '.' },
    });
  });

  it('resolves a JavaScript source package to its .js file', () => {
    const h = harness('pnpm-monorepo-declaration-dir');

    expect(resolveInFile(h, 'packages/app/lib/consumer.ts', '@demo/js')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/js/lib/index.js' },
      mapped: { from: 'packages/js/dist/index.js' },
    });
  });
});

describe('resolver bundler-built packages', () => {
  const consumer = 'packages/app/src/index.ts';

  it('maps a built package with no outDir back to its source', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/built')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/built/src/index.ts' },
      mapped: { from: 'packages/built/dist/index.d.ts' },
    });
    expect(resolveInFile(h, consumer, '@bundled/built/feature')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/built/src/feature/index.ts' },
    });
  });

  it('gives an unbuilt package the same source edge', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/unbuilt')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/unbuilt/src/index.ts' },
    });
  });

  it('maps declarations a bundler emits under dist/src', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/nested')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/nested/src/index.ts' },
    });
  });

  it('prefers the source directory over a root index beside it', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/rooted')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/rooted/src/index.ts' },
    });
  });

  it('leaves prebuilt output with no source as excluded, not unresolved', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/vendored')).toMatchObject({
      class: 'excluded',
      target: { file: 'packages/vendored/dist/widget.js' },
    });
  });

  it('leaves output renamed by a bundler as excluded, not unresolved', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/renamed')).toMatchObject({
      class: 'excluded',
      target: { file: 'packages/renamed/dist/index.d.ts' },
    });
  });

  it('trusts an output directory declared inside dist', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/nestedout')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/nestedout/src/index.ts' },
    });
  });

  it('does not map into the repo root through a wide rootDir', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/wideroot')).toMatchObject({
      class: 'workspace',
      target: { file: 'packages/wideroot/src/index.ts' },
    });
  });

  it('leaves a declaration file outside dist, build and out as excluded', () => {
    const h = harness('pnpm-monorepo-bundled');

    expect(resolveInFile(h, consumer, '@bundled/typed')).toMatchObject({
      class: 'excluded',
      target: { file: 'packages/typed/types/index.d.ts' },
    });
  });
});

describe('resolver node_modules', () => {
  it('resolves a declared, installed package from a real nested node_modules', () => {
    const h = harness('multi-app-no-workspaces');

    expect(resolveInFile(h, 'apps/web/src/uses-left-pad.ts', 'left-pad')).toEqual({
      class: 'external',
      target: { module: 'left-pad' },
    });
    expect(
      resolveCode(
        h,
        'apps/web/src/deep/nested/consumer.ts',
        "import leftPad from 'left-pad';",
        'left-pad',
      ),
    ).toEqual({ class: 'external', target: { module: 'left-pad' } });
  });

  it('classes a linked package that realpaths outside node_modules as external', (testContext) => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { linked: 'file:vendor/linked' } }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
        include: ['src'],
      }),
      'src/a.ts': "import { x } from 'linked';\nexport const y = x;\n",
      'vendor/linked/package.json': JSON.stringify({ name: 'linked', main: 'index.js' }),
      'vendor/linked/index.js': 'module.exports = { x: 1 };\n',
      'vendor/linked/index.d.ts': 'export const x: number;\n',
    });
    mkdirSync(join(dir, 'node_modules'));
    try {
      symlinkSync(join(dir, 'vendor', 'linked'), join(dir, 'node_modules', 'linked'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip('creating a symlink requires elevated privileges on this platform');
        return;
      }
      throw error;
    }

    const h = harness(dir);

    expect(resolveInFile(h, 'src/a.ts', 'linked')).toEqual({
      class: 'external',
      target: { module: 'linked' },
    });
  });

  it('does not leak a real node_modules into a sibling project without one', () => {
    const h = harness('multi-app-no-workspaces');

    expect(
      resolveCode(h, 'apps/admin/src/b.ts', "import leftPad from 'left-pad';", 'left-pad'),
    ).toEqual({ class: 'unresolved', target: null });
  });
});

describe('resolver unsupported sites', () => {
  function unsupportedSites(file: string, code: string): Resolution[] {
    const h = harness('express-js-cjs');
    const { options } = h.ctx.optionsFor(file);
    const parsed = parseFile(file, code, options);
    return parsed.sites
      .filter((site) => site.unsupported !== undefined)
      .map((site) => h.resolver.resolve(site, parsed));
  }

  it('classes unsupported sites before resolution', () => {
    expect(
      unsupportedSites('src/index.js', 'const require = () => {};\nrequire("express");\n'),
    ).toMatchObject([{ class: 'unsupported', reason: 'shadowed-require' }]);

    expect(unsupportedSites('src/index.js', 'const name = "x";\nimport(name);')).toMatchObject([
      { class: 'unsupported', reason: 'non-literal' },
    ]);
  });
});

describe('resolver parent path normalization', () => {
  it('normalizes a parent segment in an alias replacement to the intended sibling', () => {
    const h = harness('nested-project', { aliases: { '~/': '../../shared/' } });

    expect(resolveCode(h, 'tools/cli/src/b.ts', "import '~/x';", '~/x')).toMatchObject({
      class: 'internal',
      target: { file: 'shared/x.ts' },
    });
  });

  it('does not clamp an escaping alias onto an in-root lookalike', () => {
    const h = harness('nested-project', { aliases: { '~/': '../../../../shared/' } });

    const resolution = resolveCode(h, 'tools/cli/src/b.ts', "import '~/x';", '~/x');
    expect(resolution.class).toBe('unresolved');
    expect(resolution.target).toBeNull();
  });

  it('matches ignoreUnresolved against the normalized relative target', () => {
    const h = harness('nest-nodenext', { ignoreUnresolved: ['**/generated/prisma/**'] });

    expect(
      resolveCode(
        h,
        'src/users/user.repository.ts',
        "import '../generated/prisma/client.js';",
        '../generated/prisma/client.js',
      ),
    ).toEqual({ class: 'ignored', target: null, reason: 'ignore-unresolved' });
  });
});
