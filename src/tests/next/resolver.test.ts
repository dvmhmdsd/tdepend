import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SKIPS, collectFiles } from '../../next/files/collectFiles';
import { parseFile } from '../../next/parser/extractSites';
import { discoverProject } from '../../next/project/discoverProject';
import type { ProjectContext } from '../../next/project/types';
import { createResolver } from '../../next/resolver/createResolver';
import type { Resolution, ResolveOptions, Resolver } from '../../next/resolver/types';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

interface Harness {
  root: string;
  ctx: ProjectContext;
  resolver: Resolver;
  files: Set<string>;
}

function harness(name: string, options: Partial<ResolveOptions> = {}): Harness {
  const root = join(FIXTURES, name);
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
  const parsed = parseFile(file, code, options);
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

  it('reports a relative specifier matching ignoreUnresolved as ignored', () => {
    const h = harness('vite-tanstack-router', { ignoreUnresolved: ['**/routeTree.gen'] });

    expect(resolveInFile(h, 'src/main.tsx', './routeTree.gen')).toEqual({
      class: 'ignored',
      target: null,
      reason: 'ignore-unresolved',
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
