import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { collectFiles, DEFAULT_SKIPS, type CollectResult } from '../files/collectFiles';
import { nodeFileSystem } from '../fs';
import { parseFile } from '../parser/extractSites';
import { discoverProject } from '../project/discoverProject';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');
const FIXTURE = join(FIXTURES, 'vite-tanstack-router');
const GENERATED = join(FIXTURE, 'src', 'generated');

beforeAll(() => {
  mkdirSync(GENERATED, { recursive: true });
  writeFileSync(join(GENERATED, 'g.ts'), 'export const generated = true;\n');
});

afterAll(() => {
  rmSync(GENERATED, { recursive: true, force: true });
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function collect(
  options: Partial<{ include: string[]; exclude: string[]; presetSkips: string[] }> = {},
) {
  return collectFiles(discoverProject(FIXTURE), {
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    presetSkips: options.presetSkips ?? DEFAULT_SKIPS,
  });
}

function reasonOf(result: CollectResult, file: string): string | undefined {
  return result.skipped.find((entry) => entry.file === file)?.reason;
}

describe('collectFiles analysis set', () => {
  it('unions tsconfig file names with uncovered project sources', () => {
    const result = collect();

    expect(result.files).toContain('src/main.tsx');
    expect(result.files).toContain('vite.config.ts');
    expect(result.files).toContain('lib/button.ts');
    expect(result.files).toContain('src/uncovered.js');
    expect(result.uncovered).toEqual(['lib/button.ts', 'src/uncovered.js']);
  });

  it('skips spec, __tests__, stories, declarations, min.js and public by default', () => {
    const result = collect();

    for (const file of [
      'src/x.spec.ts',
      'src/__tests__/y.ts',
      'src/a.stories.tsx',
      'public/vendor.min.js',
      'public/app.js',
    ]) {
      expect(result.files).not.toContain(file);
      expect(reasonOf(result, file)).toBe('excluded');
    }

    for (const file of ['src/types.d.ts', 'src/types.d.mts', 'src/types.d.cts']) {
      expect(result.files).not.toContain(file);
      expect(reasonOf(result, file)).toBe('declaration');
    }
  });

  it('a "!" entry removes an earlier pattern', () => {
    const result = collect({ exclude: ['!**/public/**'] });

    expect(result.files).toContain('public/app.js');
    expect(result.files).not.toContain('public/vendor.min.js');
    expect(reasonOf(result, 'public/vendor.min.js')).toBe('excluded');
  });

  it('gitignored files are skipped with reason gitignored', () => {
    const result = collect();

    expect(result.files).not.toContain('src/generated/g.ts');
    expect(reasonOf(result, 'src/generated/g.ts')).toBe('gitignored');
  });

  it('honours .gitignore and .git/info/exclude but not a global excludes file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdepend-collect-git-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), 'ignored-by-gitignore.ts\n');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'ignored-by-info.ts\n');
    writeFileSync(join(dir, 'ignored-by-gitignore.ts'), 'export {};\n');
    writeFileSync(join(dir, 'ignored-by-info.ts'), 'export {};\n');
    writeFileSync(join(dir, 'global.ts'), 'export {};\n');
    writeFileSync(join(dir, 'kept.ts'), 'export {};\n');
    writeFileSync(join(dir, 'global-excludes.txt'), 'global.ts\n');
    execFileSync('git', ['config', 'core.excludesFile', join(dir, 'global-excludes.txt')], {
      cwd: dir,
    });

    const result = collectFiles(discoverProject(dir), {
      include: [],
      exclude: [],
      presetSkips: DEFAULT_SKIPS,
    });

    expect(reasonOf(result, 'ignored-by-gitignore.ts')).toBe('gitignored');
    expect(reasonOf(result, 'ignored-by-info.ts')).toBe('gitignored');
    expect(result.files).toEqual(['global.ts', 'kept.ts']);
  });

  it('a non-empty include replaces discovery but keeps preset skips', () => {
    const result = collect({ include: ['src/**/*.ts', 'src/**/*.tsx'] });

    expect(result.files).toEqual([
      'src/components/button.tsx',
      'src/features/cart/index.ts',
      'src/main.tsx',
    ]);
  });

  it('uses / separators and sorts every listing', () => {
    const result = collect();

    expect(result.files.every((file) => !file.includes('\\'))).toBe(true);
    expect(result.files).toEqual([...result.files].sort());
    expect(result.uncovered).toEqual([...result.uncovered].sort());

    const skippedFiles = result.skipped.map((entry) => entry.file);
    expect(skippedFiles).toEqual([...skippedFiles].sort());
  });
});

describe('collectFiles symlinks', () => {
  it('a symlink pointing outside the root is skipped with reason outside-root', (testContext) => {
    const dir = mkdtempSync(join(tmpdir(), 'tdepend-collect-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'linked-root', private: true }),
    );

    try {
      symlinkSync(FIXTURE, join(dir, 'linked'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        testContext.skip('creating a symlink requires elevated privileges on this platform');
        return;
      }
      throw error;
    }

    const result = collectFiles(discoverProject(dir), {
      include: [],
      exclude: [],
      presetSkips: DEFAULT_SKIPS,
    });

    expect(result.files).toEqual([]);
    expect(
      result.skipped.some((entry) => entry.file === 'linked' && entry.reason === 'outside-root'),
    ).toBe(true);
  });
});

describe('nodeFileSystem', () => {
  it('strips a byte-order mark so first-line columns match TypeScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdepend-bom-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'a.ts'), `\uFEFFimport { a } from './a';\n`);

    const text = nodeFileSystem().readFile(join(dir, 'a.ts'));

    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(parseFile('a.ts', text, {}).sites[0].column).toBe(19);
  });
});
