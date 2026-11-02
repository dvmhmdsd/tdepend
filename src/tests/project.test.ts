import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';

import { ConfigError } from '../errors';
import { discoverProject } from '../project/discoverProject';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');
const fixture = (name: string): string => join(FIXTURES, name);

const tempDirs: string[] = [];

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-project-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverProject workspace packages', () => {
  it('lists workspace packages from pnpm-workspace.yaml with directory ids', () => {
    const ctx = discoverProject(fixture('pnpm-monorepo'));

    expect(ctx.packages.map((p) => p.id)).toEqual([
      'pkg:packages/a',
      'pkg:packages/b',
      'pkg:packages/cond',
      'pkg:packages/esm',
    ]);
    expect(ctx.packages.map((p) => p.name)).toEqual([
      '@demo/a',
      '@demo/b',
      '@demo/cond',
      '@demo/esm',
    ]);
  });

  it('lists workspace packages from package.json workspaces', () => {
    const ctx = discoverProject(fixture('npm-workspaces'));

    expect(ctx.packages.map((p) => p.id)).toEqual(['pkg:packages/x', 'pkg:packages/y']);
    expect(ctx.packages.map((p) => p.name)).toEqual(['@demo/x', '@demo/y']);
  });

  it('a settings-only pnpm-workspace.yaml yields no packages', () => {
    const ctx = discoverProject(fixture('pnpm-settings-only'));

    expect(ctx.packages).toEqual([]);
  });

  it('a negated workspace glob removes matches instead of matching everything', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'neg', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/skip'\n",
      'packages/a/package.json': JSON.stringify({ name: '@neg/a' }),
      'packages/skip/package.json': JSON.stringify({ name: '@neg/skip' }),
      'apps/web/package.json': JSON.stringify({ name: '@neg/web' }),
    });

    expect(discoverProject(dir).packages.map((p) => p.name)).toEqual(['@neg/a']);
  });

  it('duplicate workspace names are a ConfigError', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'dup', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/a/package.json': JSON.stringify({ name: '@dup/same' }),
      'packages/b/package.json': JSON.stringify({ name: '@dup/same' }),
    });

    expect(() => discoverProject(dir)).toThrow(ConfigError);
  });
});

describe('discoverProject projects', () => {
  it('every directory with a dependencies package.json is a project; a nested project is not a package', () => {
    const ctx = discoverProject(fixture('nested-project'));

    expect(ctx.projects.map((p) => p.id)).toEqual(['proj:(repo)', 'proj:tools/cli']);
    expect(ctx.packages).toEqual([]);
  });

  it('two apps without workspaces are two projects with their own dependencies', () => {
    const ctx = discoverProject(fixture('multi-app-no-workspaces'));

    expect(ctx.projects.map((p) => p.id)).toEqual([
      'proj:(repo)',
      'proj:apps/admin',
      'proj:apps/web',
    ]);

    const web = ctx.projectFor('apps/web/src/a.ts');
    expect(web.id).toBe('proj:apps/web');
    expect(web.dependencies.has('next')).toBe(true);
    expect(web.dependencies.has('react')).toBe(true);

    const root = ctx.projectFor('src/a.ts');
    expect(root.id).toBe('proj:(repo)');
    expect(root.dependencies.has('next')).toBe(false);
    expect(root.dependencies.has('typescript')).toBe(true);
  });

  it('a package.json in an excluded directory is not a project', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'root', private: true }),
      'e2e/package.json': JSON.stringify({ name: 'e2e', dependencies: { playwright: '1' } }),
      'src/index.ts': 'export {};',
    });

    const ctx = discoverProject(dir, { isExcluded: (rel) => rel.startsWith('e2e/') });

    expect(ctx.projects.map((p) => p.id)).toEqual(['proj:(repo)']);
  });

  it('does not follow a symlink that points outside the root', () => {
    const outside = tempProject({
      'package.json': JSON.stringify({ name: 'outside', dependencies: { x: '1' } }),
      'tsconfig.json': JSON.stringify({ include: ['.'] }),
      'a.ts': 'export {};',
    });
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'inside', private: true }),
      'src/index.ts': 'export {};',
    });
    symlinkSync(outside, join(dir, 'linked'), 'dir');

    const ctx = discoverProject(dir);

    expect(ctx.projects.map((p) => p.id)).toEqual(['proj:(repo)']);
    expect(ctx.tsconfigs).toEqual([]);
  });
});

describe('discoverProject tsconfigs', () => {
  it('reads paths from a referenced tsconfig.app.json through JSONC', () => {
    const ctx = discoverProject(fixture('vite-tanstack-router'));

    expect(ctx.tsconfigs.length).toBe(3);

    const { options } = ctx.optionsFor('src/main.tsx');
    expect(options.paths?.['@/*']).toEqual(['./src/*']);
  });

  it('picks the nearest containing config, tie-breaking tsconfig.json first', () => {
    const ctx = discoverProject(fixture('nested-project'));

    expect(ctx.optionsFor('src/a.ts').entry?.configPath).toBe('tsconfig.json');
    expect(ctx.optionsFor('tools/cli/src/b.ts').entry?.configPath).toBe('tools/cli/tsconfig.json');
  });

  it('prefers a config in an ancestor directory over one that lists the file from elsewhere', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'near', private: true }),
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'tools/tsconfig.json': JSON.stringify({ include: ['../src'] }),
      'src/x.ts': 'export {};',
    });

    expect(discoverProject(dir).optionsFor('src/x.ts').entry?.configPath).toBe('tsconfig.json');
  });

  it('a references-only root config with no inputs is not an error', () => {
    const ctx = discoverProject(fixture('vite-tanstack-router'));

    const root = ctx.tsconfigs.find((t) => t.configPath === 'tsconfig.json');
    expect(root?.fileNames.size).toBe(0);
  });
});

describe('discoverProject fallback options', () => {
  it('falls back to NodeNext for type:module, Node10 otherwise, Bundler when vite is a dependency', () => {
    expect(
      discoverProject(fixture('fastify-esm')).optionsFor('src/index.js').options.moduleResolution,
    ).toBe(ts.ModuleResolutionKind.NodeNext);
    expect(
      discoverProject(fixture('express-js-cjs')).optionsFor('src/index.js').options
        .moduleResolution,
    ).toBe(ts.ModuleResolutionKind.Node10);
    expect(
      discoverProject(fixture('pnpm-settings-only')).optionsFor('src/index.ts').options
        .moduleResolution,
    ).toBe(ts.ModuleResolutionKind.Bundler);
  });
});

describe('discoverProject config diagnostics', () => {
  it('a broken extends (5083) is a ConfigError naming the file', () => {
    try {
      discoverProject(fixture('broken-tsconfig'));
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('tsconfig.json');
    }
  });

  it('an invalid option value (6046) is a ConfigError naming the file', () => {
    const dir = tempProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'not-a-target' },
        include: ['src'],
      }),
      'src/index.ts': 'export {};',
    });

    try {
      discoverProject(dir);
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('tsconfig.json');
    }
  });

  it('an unknown compiler option (5023) is reported once as unknown-compiler-option, ignored, and does not throw', () => {
    const dir = tempProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { experimentalFoo: true },
        include: ['src'],
      }),
      'src/index.ts': 'export {};',
    });

    const ctx = discoverProject(dir);

    expect(ctx.warnings.filter((w) => w.includes('unknown-compiler-option')).length).toBe(1);
    expect(ctx.tsconfigs.length).toBe(1);
  });

  it('an unknown option with a suggestion (5025) is a warning too', () => {
    const dir = tempProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { moduleResolutoin: 'node' },
        include: ['src'],
      }),
      'src/index.ts': 'export {};',
    });

    const ctx = discoverProject(dir);

    expect(ctx.warnings).toEqual(['unknown-compiler-option: tsconfig.json']);
  });

  it('a config with no inputs (18003) is ignored', () => {
    const dir = tempProject({
      'tsconfig.json': JSON.stringify({ include: ['nothing-here'] }),
    });

    const ctx = discoverProject(dir);

    expect(ctx.tsconfigs.length).toBe(1);
  });
});

describe('discoverProject isIgnored', () => {
  it('honours nested .gitignore and .git/info/exclude but not a global excludes file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdepend-ignore-'));
    tempDirs.push(dir);

    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'root-ignored.txt\n');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', '.gitignore'), 'nested.txt\n');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'excluded-by-info.txt\n');

    const globalExcludes = join(dir, 'global-excludes.txt');
    writeFileSync(globalExcludes, 'global.txt\n');
    execFileSync('git', ['config', 'core.excludesFile', globalExcludes], { cwd: dir });

    const ctx = discoverProject(dir);

    expect(ctx.isIgnored('root-ignored.txt')).toBe(true);
    expect(ctx.isIgnored('sub/nested.txt')).toBe(true);
    expect(ctx.isIgnored('excluded-by-info.txt')).toBe(true);
    expect(ctx.isIgnored('global.txt')).toBe(false);
    expect(ctx.isIgnored('src/ok.ts')).toBe(false);
  });

  it('reads the .gitignore files above a root that sits inside the repository', () => {
    const top = mkdtempSync(join(tmpdir(), 'tdepend-ignore-top-'));
    tempDirs.push(top);
    execFileSync('git', ['init', '-q'], { cwd: top });
    writeFileSync(join(top, '.gitignore'), '*.log\n');
    mkdirSync(join(top, 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(join(top, 'apps', '.gitignore'), 'generated/\n');

    const ctx = discoverProject(join(top, 'apps', 'web'));

    expect(ctx.isIgnored('src/debug.log')).toBe(true);
    expect(ctx.isIgnored('src/generated/x.ts')).toBe(true);
    expect(ctx.isIgnored('src/ok.ts')).toBe(false);
  });
});
