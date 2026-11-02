import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyze } from '../api/analyze';
import { exportToFile } from '../api/export';
import { toSerializable } from '../api/serialization';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('toSerializable', () => {
  it('is byte-identical across two runs and carries no timestamp', async () => {
    const first = JSON.stringify(toSerializable(await analyze({ root: join(FIXTURES, 'nest-cjs') })));
    const second = JSON.stringify(toSerializable(await analyze({ root: join(FIXTURES, 'nest-cjs') })));

    expect(second).toBe(first);
    expect(first).not.toContain('timestamp');

    const parsed = JSON.parse(first);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.files)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
    expect(Array.isArray(parsed.sites)).toBe(true);
    expect(parsed.sites.some((site: { file: string }) => site.file === 'src/user.controller.ts')).toBe(
      true,
    );
    expect(parsed.report.warnings).toEqual([]);
  });

  it('carries the resolution reason and discovery warnings', async () => {
    const serializable = toSerializable(
      await analyze({ root: join(FIXTURES, 'vite-tanstack-router-missing-gen') }),
    );

    const gen = serializable.sites.find((site) => site.specifier === './routeTree.gen');
    expect(gen).toMatchObject({ class: 'ignored', reason: 'gitignored' });
    expect(Array.isArray(serializable.report.warnings)).toBe(true);
  });

  it('keeps the export free of parser nodes', async () => {
    const serializable = toSerializable(await analyze({ root: join(FIXTURES, 'nest-cjs') }));

    for (const site of serializable.sites) {
      expect(Object.prototype.hasOwnProperty.call(site, 'node')).toBe(false);
    }
  });
});

describe('exportToFile', () => {
  it('writes the serializable result as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdepend-export-'));
    tempDirs.push(dir);
    const out = join(dir, 'result.json');

    await exportToFile(await analyze({ root: join(FIXTURES, 'nest-cjs') }), out);

    const written = JSON.parse(readFileSync(out, 'utf-8'));
    expect(written.version).toBe(1);
    expect(written.files).toContain('src/user.controller.ts');
  });
});
