import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ParseError } from '../../next/errors';
import { nodeFileSystem, type FileSystemLike } from '../../next/fs';
import { FIXTURES, buildFixture, edgeTuples, expectedEdges } from './helpers/fixtureGraph';

const REPO_FIXTURES = [
  'case-insensitive',
  'express-js-cjs',
  'fastify-esm',
  'feature-frontend',
  'multi-app-no-workspaces',
  'nest-cjs',
  'nest-monorepo-paths',
  'nest-nodenext',
  'nested-project',
  'next-app',
  'node-library',
  'npm-workspaces',
  'pnpm-monorepo',
  'pnpm-monorepo-declaration-dir',
  'pnpm-monorepo-unbuilt',
  'pnpm-settings-only',
  'tanstack-start',
  'vite-tanstack-router',
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-graph-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// The golden case of this fixture only holds where the file system folds case.
function isCaseInsensitiveFileSystem(): boolean {
  return existsSync(join(FIXTURES, 'case-insensitive', 'src', 'MAIN-LAYOUT.TSX'));
}

function generateLargeFixture(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-graph-large-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'large', private: true }));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'commonjs', moduleResolution: 'node', strict: true, rootDir: 'src' },
      include: ['src'],
    }),
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const source =
      index === 0
        ? `export const value0 = 0;\n`
        : `import { value${index - 1} } from './file${index - 1}';\n\nexport const value${index} = value${index - 1};\n`;
    writeFileSync(join(dir, 'src', `file${index}.ts`), source);
  }
  return dir;
}

describe('fixture graph golden edges', () => {
  for (const name of REPO_FIXTURES) {
    const runs = name === 'case-insensitive' && !isCaseInsensitiveFileSystem() ? it.skip : it;
    runs(`fixture ${name} produces its expected edges`, () => {
      expect(edgeTuples(buildFixture(name))).toEqual(expectedEdges(name));
    });
  }
});

describe('file graph structure', () => {
  it('counts a self-import without making it an edge', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'self-import', private: true }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'commonjs', moduleResolution: 'node', strict: true },
        include: ['src'],
      }),
      'src/self.ts': `import { self } from './self';\n\nexport const value = self;\n`,
    });

    const result = buildFixture('self-import', { root: dir });

    expect(result.report.selfImports).toEqual(['src/self.ts']);
    expect(result.graph.edges()).toEqual([]);
  });

  it('fails loudly when a collected file cannot be read', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ name: 'unreadable', private: true }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'commonjs', moduleResolution: 'node', strict: true },
        include: ['src'],
      }),
      'src/a.ts': `import { b } from './b';\n\nexport const a = b;\n`,
      'src/b.ts': `export const b = 1;\n`,
    });

    const fs = nodeFileSystem();
    const failing: FileSystemLike = {
      ...fs,
      readFile: (path) => {
        if (path.endsWith('b.ts')) throw new Error('EACCES: permission denied');
        return fs.readFile(path);
      },
    };

    try {
      buildFixture('unreadable', { root: dir, fs: failing });
      expect.unreachable('expected the unreadable file to fail the build');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as Error).message).toContain('src/b.ts');
    }
  });

  it('keeps every site in sites[] with a class, including builtin and external ones', () => {
    const vite = buildFixture('vite-tanstack-router');
    const parsedSites = [...vite.parsed.values()].reduce((total, file) => total + file.sites.length, 0);

    expect(vite.sites).toHaveLength(parsedSites);
    expect(vite.sites.every((record) => typeof record.resolution.class === 'string')).toBe(true);
    expect(vite.report.stats.builtin).toBeGreaterThan(0);

    const multiApp = buildFixture('multi-app-no-workspaces');
    expect(multiApp.report.stats.external).toBeGreaterThan(0);
  });

  it('gives the same edges when the root is a symlink', (testContext) => {
    const dir = mkdtempSync(join(tmpdir(), 'tdepend-graph-link-'));
    tempDirs.push(dir);

    try {
      symlinkSync(join(FIXTURES, 'nest-cjs'), join(dir, 'linked'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip('creating a symlink requires elevated privileges on this platform');
        return;
      }
      throw error;
    }

    expect(edgeTuples(buildFixture('nest-cjs', { root: join(dir, 'linked') }))).toEqual(
      expectedEdges('nest-cjs'),
    );
  });

  it('resolves an import whose letter case differs from the file on a case-insensitive file system', () => {
    if (!isCaseInsensitiveFileSystem()) return;

    expect(edgeTuples(buildFixture('case-insensitive'))).toEqual([
      ['src/app.tsx', 'src/main-layout.tsx', ['static'], true],
    ]);
  });

  it('graph.id is stable across two builds and changes when an edge changes', () => {
    expect(buildFixture('nest-cjs').graph.id).toBe(buildFixture('nest-cjs').graph.id);
    expect(buildFixture('nest-cjs').graph.id).not.toBe(buildFixture('fastify-esm').graph.id);
  });

  it('graph.id changes when a site only moves between filtering categories', () => {
    const tsconfig = JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', strict: true },
      include: ['src'],
    });
    const topLevel = tempProject({
      'package.json': JSON.stringify({ name: 'lazy-top', private: true }),
      'tsconfig.json': tsconfig,
      'src/dep.ts': `export const dep = 1;\n`,
      'src/entry.ts': `import('./dep');\n`,
    });
    const nested = tempProject({
      'package.json': JSON.stringify({ name: 'lazy-nested', private: true }),
      'tsconfig.json': tsconfig,
      'src/dep.ts': `export const dep = 1;\n`,
      'src/entry.ts': `export function load() {\n  return import('./dep');\n}\n`,
    });

    const top = buildFixture('lazy-top', { root: topLevel });
    const inner = buildFixture('lazy-nested', { root: nested });

    // Same edge shape, so `runtime` and the file pair cannot tell them apart.
    expect(edgeTuples(top)).toEqual([['src/entry.ts', 'src/dep.ts', ['dynamic'], true]]);
    expect(edgeTuples(inner)).toEqual([['src/entry.ts', 'src/dep.ts', ['dynamic'], true]]);

    // `deferred` differs, and cycle filtering reads it, so the ids must differ.
    expect(top.graph.id).not.toBe(inner.graph.id);
  });

  it('treats two files outside every package as an internal edge', () => {
    const result = buildFixture('pnpm-monorepo');

    const edge = result.graph
      .edges()
      .find((candidate) => candidate.from === 'scripts/seed.ts' && candidate.to === 'scripts/util.ts');
    expect(edge).toBeDefined();

    const record = result.sites.find((candidate) => candidate.file === 'scripts/seed.ts');
    expect(record?.resolution.class).toBe('internal');
  });
});

describe('file graph timing', () => {
  it('parses and resolves a generated 2,000-file fixture under 4 s', () => {
    const dir = generateLargeFixture(2000);

    const started = performance.now();
    const result = buildFixture('large', { root: dir });
    const elapsed = performance.now() - started;

    expect(result.graph.files()).toHaveLength(2000);
    expect(elapsed).toBeLessThan(4000);
  });
});
