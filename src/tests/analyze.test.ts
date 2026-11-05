import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyze } from '../api/analyze';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tdepend-analyze-')));
  tempDirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('analyze tsconfig discovery', () => {
  it('parses a tsconfig whose name matches a preset test skip', async () => {
    const root = tempProject({
      'package.json': '{}',
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'tsconfig.spec.json': JSON.stringify({ include: ['jest.config.ts'] }),
      'jest.config.ts': 'export default {};',
      'src/index.ts': 'export {};',
    });

    const result = await analyze({ root });

    expect(result.ctx.tsconfigs.map((entry) => entry.configPath)).toContain('tsconfig.spec.json');
    expect(result.files.uncovered).not.toContain('jest.config.ts');
  });

  it('skips a broken tsconfig the user excluded', async () => {
    const root = tempProject({
      'package.json': '{}',
      'tdepend.config.json': JSON.stringify({ exclude: ['fixtures/**'] }),
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'fixtures/broken/tsconfig.json': JSON.stringify({ extends: './missing.json' }),
      'src/index.ts': 'export {};',
    });

    const result = await analyze({ root });

    expect(result.ctx.tsconfigs.map((entry) => entry.configPath)).toEqual(['tsconfig.json']);
  });
});

describe('analyze', () => {
  it('reports unresolved imports with file and line and the site class counts', async () => {
    const result = await analyze({ root: join(FIXTURES, 'vite-tanstack-router') });

    expect(result.report.stats.asset).toBe(2);
    expect(result.report.stats.virtual).toBe(1);
    expect(result.report.stats.excluded).toBe(2);

    const missing = result.report.unresolved.find((record) => record.site.specifier === './missing');
    expect(missing?.file).toBe('src/main.tsx');
    expect(missing?.site.line).toBe(6);
  });

  it('counts a gitignored, absent generated file as ignored without any config', async () => {
    const result = await analyze({ root: join(FIXTURES, 'vite-tanstack-router-missing-gen') });

    expect(result.report.stats.ignored).toBe(1);
    expect(result.report.stats.unresolved).toBe(0);
    expect(result.report.ignoredByDir).toEqual({ 'src/': 1 });
  });

  it('builds a graph over the analysis set with classified sites for every import', async () => {
    const result = await analyze({ root: join(FIXTURES, 'nest-cjs') });

    expect(result.graph.files()).toContain('src/user.controller.ts');
    expect(result.graph.edges()).not.toHaveLength(0);
    expect(result.sites.every((record) => typeof record.resolution.class === 'string')).toBe(true);
    expect(result.report.stats.internal).toBeGreaterThan(0);
  });
});
