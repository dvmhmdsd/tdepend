import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyze } from '../api/analyze';
import { check, type CheckReport } from '../api/check';
import { init } from '../api/init';
import { toSerializable } from '../api/serialization';
import {
  compareWithBaseline,
  pruneBaseline,
  readBaseline,
  toBaselineFile,
  writeBaseline,
} from '../baseline/baseline';
import { runCli } from '../cli/run';
import { exitCodeFor } from '../output/exitCode';
import { formatJson, formatText } from '../output/formatCheck';
import { formatAnalyzeText } from '../output/analyzeText';
import { finishViolation } from '../rules/identity';
import type { Violation } from '../rules/types';
import { FIXTURES } from './helpers/fixtureGraph';

let dir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdepend-check-'));
  stdout = '';
  stderr = '';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const io = () => ({
  cwd: dir,
  stdout: (s: string) => {
    stdout += s;
  },
  stderr: (s: string) => {
    stderr += s;
  },
});

// Configs live in the temp folder, so a baseline they name is written there and
// never into a fixture.
function writeConfig(config: Record<string, unknown>): string {
  const path = join(dir, 'tdepend.config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const CONTROLLER_RULE = {
  type: 'forbidden',
  id: 'LAYER-CONTROLLER-REPO-001',
  from: ['src/**/*.controller.ts'],
  to: ['src/**/*.repository.ts'],
  message: 'Controllers call services, not repositories.',
};

const NEST = join(FIXTURES, 'nest-cjs');

describe('check', () => {
  it('check on nest-cjs with LAYER-CONTROLLER-REPO-001 returns actionable violations and exit 1', async () => {
    const report = await check({ root: NEST, config: writeConfig({ rules: [CONTROLLER_RULE] }) });

    expect(report.actionable.map((violation) => [violation.ruleId, violation.from])).toEqual([
      ['LAYER-CONTROLLER-REPO-001', 'src/admin.controller.ts'],
    ]);
    expect(report.known).toEqual([]);
    expect(report.exitCode).toBe(1);
  });

  it('text line format', async () => {
    const report = await check({ root: NEST, config: writeConfig({ rules: [CONTROLLER_RULE] }) });
    const text = formatText(report);

    expect(text).toContain(
      "  src/admin.controller.ts:1:32  LAYER-CONTROLLER-REPO-001  Controllers call services, not repositories.  ('./user.repository' → src/user.repository.ts)",
    );
    expect(text).toContain('1 error, 0 warnings.');
  });

  it('the library applies strictResolution to the exit code, as the CLI does', async () => {
    const root = join(FIXTURES, 'vite-tanstack-router');
    expect((await check({ root })).exitCode).toBe(0);
    expect((await check({ root, strictResolution: true })).exitCode).toBe(2);
    expect(await runCli(['check', '--root', root, '--strict-resolution'], io())).toBe(2);
  });

  it('text output lists unresolved imports and says when they are why it exits 2', async () => {
    const root = join(FIXTURES, 'vite-tanstack-router');
    const lenient = formatText(await check({ root }));
    expect(lenient).toContain('Unresolved imports (2):\n  src/main.tsx:6  ./missing');
    expect(lenient).not.toContain('Exit 2');

    expect(formatText(await check({ root, strictResolution: true }))).toContain(
      '0 errors, 0 warnings. Exit 2: 2 unresolved imports under --strict-resolution.',
    );
  });

  it('notes when no config was found, so only the presets ran', async () => {
    const without = await check({ root: NEST });
    expect(without.warnings).toContain(
      `No tdepend.config.json in ${NEST}; only the presets' rules ran.`,
    );
    const withConfig = await check({ root: NEST, config: writeConfig({}) });
    expect(
      withConfig.warnings.some((warning) => warning.startsWith('No tdepend.config.json')),
    ).toBe(false);
  });

  it('coverage text line has no line:col', async () => {
    const config = writeConfig({
      components: { type: 'directory', patterns: ['src/*'], coverage: { requireAll: true } },
    });
    const report = await check({ root: join(FIXTURES, 'layered-backend'), config });

    expect(formatText(report)).toContain(
      '  src/config.ts  components/coverage  File belongs to no declared component. Add it to a component pattern or to `allowUnmatched`.',
    );
  });

  it('a coverage finding and an unresolved workspace-subpath finding round-trip through json, baseline write/read/prune and text', async () => {
    const config = writeConfig({
      components: { type: 'directory', patterns: ['src/*'], coverage: { requireAll: true } },
    });
    const analysed = await check({ root: join(FIXTURES, 'layered-backend'), config });
    const coverage = analysed.actionable.find((violation) => violation.kind === 'coverage')!;
    const deepImport = finishViolation({
      kind: 'import',
      ruleId: 'NO-DEEP',
      projectId: 'proj:(repo)',
      severity: 'error',
      message: 'Use the package entry.',
      from: 'apps/web/src/a.ts',
      to: { module: '@demo/b/src/internal', workspace: true },
      site: {
        specifier: '@demo/b/src/internal',
        line: 2,
        column: 19,
        kind: 'static',
        form: 'declaration',
        bindings: [],
      },
    });
    const report: CheckReport = {
      ...analysed,
      actionable: [coverage, deepImport],
      violations: [coverage, deepImport],
    };

    const json = JSON.parse(formatJson(report));
    expect(json.actionable).toEqual([coverage, deepImport]);

    const path = join(dir, 'baseline.json');
    writeBaseline(path, [coverage, deepImport]);
    const read = readBaseline(path);
    expect([...read.values()].map((entry) => [entry.kind, entry.target ?? null])).toEqual([
      ['import', { module: '@demo/b/src/internal', workspace: true }],
      ['coverage', null],
    ]);
    expect(compareWithBaseline([coverage, deepImport], read).known).toHaveLength(2);
    expect(pruneBaseline(read, [coverage, deepImport])).toEqual(
      toBaselineFile([coverage, deepImport]),
    );

    const text = formatText(report);
    expect(text).toContain(`  ${coverage.from}  components/coverage  `);
    expect(text).toContain(
      "  apps/web/src/a.ts:2:19  NO-DEEP  Use the package entry.  ('@demo/b/src/internal' → @demo/b/src/internal)",
    );
  });

  it('warnings alone exit 0; strictResolution with unresolved exits 2; 2 wins over 1', () => {
    const violation = (severity: 'error' | 'warn'): Violation =>
      finishViolation({
        kind: 'coverage',
        ruleId: 'components/coverage',
        projectId: 'proj:(repo)',
        severity,
        message: 'm',
        from: 'src/a.ts',
      });
    const resolved = { unresolved: [] } as unknown as CheckReport['report'];
    const unresolved = { unresolved: [{}] } as unknown as CheckReport['report'];
    const strict = { strictResolution: true };

    expect(exitCodeFor({ actionable: [violation('warn')], report: resolved }, strict)).toBe(0);
    expect(exitCodeFor({ actionable: [], report: unresolved }, strict)).toBe(2);
    expect(exitCodeFor({ actionable: [], report: unresolved }, { strictResolution: false })).toBe(
      0,
    );
    expect(exitCodeFor({ actionable: [violation('error')], report: unresolved }, strict)).toBe(2);
    expect(exitCodeFor({ actionable: [violation('error')], report: resolved }, strict)).toBe(1);
  });
});

describe('baselines from the CLI', () => {
  it('check --baseline returns 0 when every violation is known and prints no-longer-reported entries', async () => {
    const config = writeConfig({ rules: [CONTROLLER_RULE] });
    const report = await check({ root: NEST, config });
    const gone = finishViolation({ ...report.actionable[0], from: 'src/gone.controller.ts' });
    const path = join(dir, 'accepted.json');
    writeBaseline(path, [...report.actionable, gone]);

    const code = await runCli(
      ['check', '--root', NEST, '--config', config, '--baseline', path],
      io(),
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('No longer reported (1):');
    expect(stdout).toContain(
      '  LAYER-CONTROLLER-REPO-001  src/gone.controller.ts → src/user.repository.ts  (accepted 1)',
    );
    expect(stdout).toContain('0 errors, 0 warnings, 1 known from the baseline.');
  });

  it('without a baseline key, check reads the file `tdepend baseline` wrote next to the config', async () => {
    const config = writeConfig({ rules: [CONTROLLER_RULE] });
    expect(await runCli(['check', '--root', NEST, '--config', config], io())).toBe(1);

    expect(await runCli(['baseline', '--root', NEST, '--config', config], io())).toBe(0);
    expect(stdout).toContain(join(dir, 'tdepend-baseline.json'));
    stdout = '';
    expect(await runCli(['check', '--root', NEST, '--config', config], io())).toBe(0);
    expect(stdout).toContain('0 errors, 0 warnings, 1 known from the baseline.');
  });

  it('baseline writes a version 1 file; baseline --prune never increases debt', async () => {
    const config = writeConfig({ rules: [CONTROLLER_RULE], baseline: 'debt.json' });
    const path = join(dir, 'debt.json');

    expect(await runCli(['baseline', '--root', NEST, '--config', config], io())).toBe(0);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.version).toBe(1);
    expect(written.entries).toHaveLength(1);
    expect(await runCli(['check', '--root', NEST, '--config', config], io())).toBe(0);

    const [entry] = written.entries;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { ...entry, count: 5 },
          { ...entry, fingerprint: 'stale', from: 'src/old.ts' },
        ],
      }),
    );
    expect(await runCli(['baseline', '--prune', '--root', NEST, '--config', config], io())).toBe(0);
    const pruned = JSON.parse(readFileSync(path, 'utf-8'));
    expect(pruned.entries).toEqual([{ ...entry, count: 1 }]);
  });
});

describe('init', () => {
  it('writes presets auto, exclude [], and the detected recommended rules as warn; refuses to overwrite without --force', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@nestjs/core': '^11.0.0' } }),
    );

    const result = await init({ root: dir });
    expect(result.presets).toEqual(['nest', 'node']);
    expect(JSON.parse(readFileSync(result.written, 'utf-8'))).toEqual({
      presets: ['auto'],
      exclude: [],
      rules: [{ id: 'nest/layers', severity: 'warn' }],
    });

    await expect(init({ root: dir })).rejects.toThrow('already exists');
    expect(await runCli(['init', '--root', dir], io())).toBe(2);
    expect(await runCli(['init', '--root', dir, '--force'], io())).toBe(0);
    expect(stdout).toContain('proj:(repo): node, nest');

    const config = JSON.parse(readFileSync(result.written, 'utf-8'));
    expect(config.rules).toEqual([{ id: 'nest/layers', severity: 'warn' }]);
  });
});

describe('analyze output', () => {
  it('analyze text shows component metrics, package metrics in a workspace, and cycles with hops', async () => {
    const backend = formatAnalyzeText(await analyze({ root: join(FIXTURES, 'layered-backend') }));
    expect(backend).toMatch(/Components \(\d+\):/);
    expect(backend).toMatch(/\n {2}src\/orders\s+\d+\s+\d+/);
    expect(backend).toContain('Component cycles (1):');
    expect(backend).toContain('  src/orders → src/users → src/orders');
    expect(backend).toMatch(/\n {4}src\/orders\/[\w./]+:\d+:\d+ {2}'[^']+' → src\/users\//);
    expect(backend).not.toContain('Packages (');

    const monorepo = formatAnalyzeText(await analyze({ root: join(FIXTURES, 'pnpm-monorepo') }));
    expect(monorepo).toMatch(/Packages \(\d+\):/);
  });

  it('a distance threshold lists the components past it', async () => {
    const config = writeConfig({ metrics: { thresholds: { distance: 0 } } });
    const text = formatAnalyzeText(
      await analyze({ root: join(FIXTURES, 'layered-backend'), config }),
    );
    expect(text).toMatch(/Further than 0 from the main sequence \(\d+\):/);
  });

  it('toSerializable version 2 includes effective rule instances with severities', async () => {
    const config = writeConfig({
      rules: [CONTROLLER_RULE, { id: 'nest/layers', severity: 'warn' }],
    });
    const serializable = toSerializable(await analyze({ root: NEST, config }));

    expect(serializable.version).toBe(2);
    expect(
      serializable.rules.map((rule) => [rule.projectId, rule.id, rule.severity, rule.origin]),
    ).toEqual([
      ['proj:(repo)', 'LAYER-CONTROLLER-REPO-001', 'error', 'user'],
      ['proj:(repo)', 'nest/layers', 'warn', 'preset'],
      ['proj:(repo)', 'node/no-cycles', 'warn', 'preset'],
    ]);
    expect(serializable.components.map((group) => [group.id, group.files.length])).toEqual([
      ['dir:proj:(repo):src', 6],
    ]);
    expect(serializable.metrics.component).toHaveLength(1);
    expect(JSON.stringify(serializable)).not.toContain('"pos":');
  });
});
