import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyze } from '../api/analyze';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

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
