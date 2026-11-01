import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyze } from '../api/analyze';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Left-pad is undeclared and ./routeTree.gen is generated, so the route tree
// import only becomes `ignored` when a policy ignores it by glob.
function writeIgnoreConfig(patterns: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-analyze-'));
  tempDirs.push(dir);
  const path = join(dir, 'tdepend.config.json');
  writeFileSync(path, JSON.stringify({ resolve: { ignoreUnresolved: patterns } }));
  return path;
}

describe('analyze', () => {
  it('reports unresolved imports with file and line and the site class counts', async () => {
    const config = writeIgnoreConfig(['**/routeTree.gen']);

    const result = await analyze({ root: join(FIXTURES, 'vite-tanstack-router'), config });

    expect(result.report.stats.asset).toBe(2);
    expect(result.report.stats.virtual).toBe(1);
    expect(result.report.stats.ignored).toBe(1);

    const missing = result.report.unresolved.find((record) => record.site.specifier === './missing');
    expect(missing?.file).toBe('src/main.tsx');
    expect(missing?.site.line).toBe(6);
  });

  it('builds a graph over the analysis set with classified sites for every import', async () => {
    const result = await analyze({ root: join(FIXTURES, 'nest-cjs') });

    expect(result.graph.files()).toContain('src/user.controller.ts');
    expect(result.graph.edges()).not.toHaveLength(0);
    expect(result.sites.every((record) => typeof record.resolution.class === 'string')).toBe(true);
    expect(result.report.stats.internal).toBeGreaterThan(0);
  });
});
