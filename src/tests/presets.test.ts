import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyze } from '../api/analyze';
import { assignComponents } from '../components/assignComponents';
import { buildGroupGraph } from '../components/groupGraph';
import { configSchema, type UserConfig } from '../config/schema';
import { CycleCache } from '../cycles/findCycles';
import { ConfigError } from '../errors';
import { collectFiles } from '../files/collectFiles';
import * as presetsEntry from '../presets';
import { builtInPresets, definePreset, type Preset } from '../presets';
import { mergeConfig, type EffectiveConfig } from '../presets/mergeConfig';
import { resolvePresets } from '../presets/resolvePresets';
import type { ProjectContext } from '../project/types';
import { evaluateRules } from '../rules/evaluateRules';
import type { RuleConfig, RuleEvaluation, RuleInstance } from '../rules/types';
import { buildSymbolIndex } from '../symbols/symbolIndex';
import { FIXTURES, buildFixtureParts } from './helpers/fixtureGraph';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __tdependTestPreset?: Preset }).__tdependTestPreset;
});

const userConfig = (config: Record<string, unknown> = {}): UserConfig => configSchema.parse(config);

function namesByProject(name: string, selection = ['auto']): Record<string, string[]> {
  const { ctx } = buildFixtureParts(name);
  const presets = resolvePresets(selection, ctx, join(FIXTURES, name));
  return Object.fromEntries(
    [...presets].map(([projectId, list]) => [projectId, list.map((preset) => preset.name)]),
  );
}

function effectiveFor(
  name: string,
  config: Record<string, unknown> = {},
): { ctx: ProjectContext; effective: EffectiveConfig } {
  const { ctx } = buildFixtureParts(name);
  const user = userConfig(config);
  const presets = resolvePresets(user.presets, ctx, join(FIXTURES, name));
  return { ctx, effective: mergeConfig(user, presets, ctx) };
}

// Evaluates the effective rule instances over a fixture, with components
// assigned by the effective strategy.
function check(name: string, rules: RuleConfig[] = []): RuleEvaluation {
  const parts = buildFixtureParts(name);
  const user = userConfig({ rules });
  const effective = mergeConfig(
    user,
    resolvePresets(user.presets, parts.ctx, join(FIXTURES, name)),
    parts.ctx,
  );
  const assignment = assignComponents(parts.ctx, parts.graph.files(), effective.strategyFor);
  return evaluateRules(
    {
      ctx: parts.ctx,
      graph: parts.graph,
      sites: parts.sites,
      assignment,
      groups: { component: buildGroupGraph(parts.graph, assignment, 'component', parts.sites) },
      index: buildSymbolIndex(parts.graph, parts.parsed, parts.sites),
      coverage: effective.coverage,
      cycleCache: new CycleCache(),
    },
    effective.instances,
  );
}

const summary = (evaluation: RuleEvaluation) =>
  evaluation.violations.map((violation) => [
    violation.projectId,
    violation.ruleId,
    violation.severity,
    violation.from,
    violation.site?.line,
    violation.to,
    violation.message,
  ]);

function instanceOf(effective: EffectiveConfig, projectId: string, id: string): RuleInstance {
  const found = effective.instances.find(
    (instance) => instance.projectId === projectId && instance.rule.id === id,
  );
  if (found === undefined) throw new Error(`no instance ${projectId} ${id}`);
  return found;
}

function presetModules(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-presets-'));
  tempDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('resolvePresets', () => {
  it('auto picks node plus presets whose detect matches, per project', () => {
    expect(namesByProject('preset-projects')).toEqual({
      'proj:(repo)': ['node', 'express'],
      'proj:apps/api': ['node', 'nest'],
      'proj:apps/web': ['node', 'react'],
    });
    expect(namesByProject('nest-cjs')).toEqual({ 'proj:(repo)': ['node', 'nest'] });
    expect(namesByProject('fastify-esm')).toEqual({ 'proj:(repo)': ['node', 'fastify'] });
    expect(namesByProject('feature-frontend')).toEqual({ 'proj:(repo)': ['node', 'react'] });
  });

  it('react is not selected when next is a dependency of the same project', () => {
    expect(namesByProject('multi-app-no-workspaces')).toEqual({
      'proj:(repo)': ['node'],
      'proj:apps/admin': ['node'],
      'proj:apps/web': ['node'],
    });
  });

  it('a listed built-in narrows auto to that preset; a preset reached twice appears once', () => {
    expect(namesByProject('preset-projects', ['react'])).toEqual({
      'proj:(repo)': ['node'],
      'proj:apps/api': ['node'],
      'proj:apps/web': ['node', 'react'],
    });
    expect(namesByProject('preset-projects', ['auto', 'react', 'node'])).toEqual(
      namesByProject('preset-projects'),
    );
  });

  it('an unknown preset name is a ConfigError listing the names', () => {
    const { ctx } = buildFixtureParts('nest-cjs');
    const dir = join(FIXTURES, 'nest-cjs');
    expect(() => resolvePresets(['auto', 'nope'], ctx, dir)).toThrow(ConfigError);
    expect(() => resolvePresets(['auto', 'nope'], ctx, dir)).toThrow(
      `Unknown preset "nope". Built-in presets: express, fastify, nest, node, react. Any other entry must be a module that resolves from ${dir}.`,
    );
  });

  it('a planned preset name is unknown and never loads the package of that name', () => {
    const dir = presetModules({});
    mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'next', 'package.json'),
      '{"name":"next","main":"index.js"}',
    );
    writeFileSync(
      join(dir, 'node_modules', 'next', 'index.js'),
      "require('fs').writeFileSync(__dirname + '/ran', '1');\n",
    );
    const { ctx } = buildFixtureParts('nest-cjs');

    expect(() => resolvePresets(['auto', 'next'], ctx, dir)).toThrow('Unknown preset "next"');
    expect(existsSync(join(dir, 'node_modules', 'next', 'ran'))).toBe(false);
  });

  it('a module specifier loads a definePreset export, CommonJS or ESM, with what it extends', () => {
    (globalThis as { __tdependTestPreset?: Preset }).__tdependTestPreset = definePreset({
      name: 'acme',
      detect: (project) => project.dependencies.has('@nestjs/core'),
      extends: ['react'],
    });
    const dir = presetModules({
      'acme.cjs': 'module.exports = globalThis.__tdependTestPreset;\n',
      'acme.mjs': 'export default globalThis.__tdependTestPreset;\n',
    });
    const { ctx } = buildFixtureParts('nest-cjs');
    const names = (selection: string[]) =>
      resolvePresets(selection, ctx, dir)
        .get('proj:(repo)')
        ?.map((preset) => preset.name);

    expect(names(['./acme.cjs'])).toEqual(['node', 'react', 'acme']);
    expect(names(['./acme.mjs'])).toEqual(['node', 'react', 'acme']);
    expect(names(['auto', './acme.cjs'])).toEqual(['node', 'nest', 'react', 'acme']);
  });

  it('a module that fails to load or exports something else is a ConfigError', () => {
    const dir = presetModules({
      'plain.cjs': "module.exports = { name: 'plain', detect: () => true };\n",
      'broken.cjs': "throw new Error('boom');\n",
    });
    const { ctx } = buildFixtureParts('nest-cjs');

    expect(() => resolvePresets(['./plain.cjs'], ctx, dir)).toThrow(
      'Preset ./plain.cjs must export a preset made with definePreset',
    );
    expect(() => resolvePresets(['./broken.cjs'], ctx, dir)).toThrow(
      'Preset ./broken.cjs failed to load: boom',
    );
  });

  it('definePreset rejects a preset without a name or with a malformed rule', () => {
    expect(() => definePreset({ name: '', detect: () => true })).toThrow(ConfigError);
    expect(() =>
      definePreset({
        name: 'bad',
        detect: () => true,
        rules: [{ type: 'forbidden', id: 'x', from: ['a'], to: ['b'] } as never],
      }),
    ).toThrow('Invalid preset bad');
  });

  it('tdepend/presets exports definePreset and the built-in presets', () => {
    expect(Object.keys(presetsEntry).sort()).toEqual(['builtInPresets', 'definePreset']);
    expect(Object.keys(builtInPresets)).toEqual(['node', 'nest', 'react', 'express', 'fastify']);
  });
});

describe('mergeConfig: skips', () => {
  it('node skips public/** and *.min.js; "!" in user exclude removes one', () => {
    const { ctx, effective } = effectiveFor('vite-tanstack-router', {
      exclude: ['!**/public/**'],
    });
    expect(effective.skips).toContain('**/*.min.js');
    expect(effective.skips).not.toContain('**/public/**');

    const { files } = collectFiles(ctx, {
      include: [],
      exclude: effective.exclude,
      presetSkips: effective.skips,
    });
    expect(files).toContain('public/app.js');
    expect(files).not.toContain('public/vendor.min.js');
  });

  it('preset skips are rebased to their project; "!" removes a skip in every project', () => {
    const { effective } = effectiveFor('preset-projects');
    expect(effective.skips).toContain('apps/api/test/**');
    expect(effective.skips).not.toContain('test/**');
    expect(effective.skips).toEqual(
      expect.arrayContaining(['e2e/**', 'apps/api/e2e/**', 'apps/web/e2e/**']),
    );

    const removed = effectiveFor('preset-projects', { exclude: ['!e2e/**'] }).effective;
    expect(removed.skips.filter((skip) => skip.endsWith('e2e/**'))).toEqual([]);
    expect(removed.exclude).toEqual(['!e2e/**']);
  });

  it('analyze collects files with each project’s own preset skips', async () => {
    const result = await analyze({ root: join(FIXTURES, 'preset-projects') });

    expect(result.files.files).toContain('test/helpers.ts');
    expect(result.files.files).not.toContain('apps/api/test/e2e.ts');
    expect(result.files.skipped).toContainEqual({
      file: 'apps/api/test/e2e.ts',
      reason: 'excluded',
    });
  });
});

describe('mergeConfig: components', () => {
  it('user components apply to every project; otherwise nest beats react beats node', () => {
    const { ctx, effective } = effectiveFor('preset-projects');
    const strategyOf = (id: string) =>
      effective.strategyFor(ctx.projects.find((project) => project.id === id)!);
    expect(strategyOf('proj:(repo)')).toEqual({ type: 'directory', patterns: ['src/*'] });
    expect(strategyOf('proj:apps/api')).toEqual({ type: 'nest-module' });
    expect(strategyOf('proj:apps/web')).toEqual({
      type: 'directory',
      patterns: ['src/features/*', 'src/*'],
    });

    const user = effectiveFor('preset-projects', { components: { type: 'file' } });
    for (const project of user.ctx.projects) {
      expect(user.effective.strategyFor(project)).toEqual({ type: 'file' });
    }

    const root = ctx.projects[0];
    const { nest, node, react } = builtInPresets;
    const pick = (list: Preset[]) =>
      mergeConfig(userConfig(), new Map([[root.id, list]]), ctx).strategyFor(root);
    expect(pick([node, react, nest])).toEqual({ type: 'nest-module' });
    expect(pick([node, nest, react])).toEqual({ type: 'nest-module' });
    expect(pick([node, react])).toEqual(react.components);
    expect(pick([node])).toEqual(node.components);
  });

  it('a user components setting gives its coverage and drops it from the strategy', () => {
    const { ctx, effective } = effectiveFor('nest-cjs', {
      components: { type: 'directory', patterns: ['src/*'], coverage: { requireAll: true } },
    });
    expect(effective.strategyFor(ctx.projects[0])).toEqual({
      type: 'directory',
      patterns: ['src/*'],
    });
    expect(effective.coverage).toEqual({ requireAll: true, allowUnmatched: [] });
    expect(effectiveFor('nest-cjs').effective.coverage).toBeUndefined();
  });

  it('nest: components follow *.module.ts folders', () => {
    const parts = buildFixtureParts('nest-cjs');
    const { effective } = effectiveFor('nest-cjs');
    const assignment = assignComponents(parts.ctx, parts.graph.files(), effective.strategyFor);

    expect(effective.strategyFor(parts.ctx.projects[0])).toEqual({ type: 'nest-module' });
    expect(new Set(assignment.components.map((group) => group.id))).toEqual(
      new Set(['dir:proj:(repo):src']),
    );
  });
});

describe('mergeConfig: rules', () => {
  it('nest/layers is off by default; with { id, severity: "warn" } the controller → repository import warns', () => {
    const { effective } = effectiveFor('nest-cjs');
    expect(instanceOf(effective, 'proj:(repo)', 'nest/layers').rule.severity).toBe('off');
    expect(check('nest-cjs').violations).toEqual([]);

    expect(summary(check('nest-cjs', [{ id: 'nest/layers', severity: 'warn' }]))).toEqual([
      [
        'proj:(repo)',
        'nest/layers',
        'warn',
        'src/admin.controller.ts',
        1,
        { file: 'src/user.repository.ts' },
        'Controllers call services, not repositories.',
      ],
    ]);
  });

  it('react: shared → features is off by default and warns when enabled', () => {
    expect(check('vite-tanstack-router').violations).toEqual([]);
    expect(
      summary(
        check('vite-tanstack-router', [{ id: 'react/shared-no-feature-import', severity: 'warn' }]),
      ),
    ).toEqual([
      [
        'proj:(repo)',
        'react/shared-no-feature-import',
        'warn',
        'src/shared/x.ts',
        1,
        { file: 'src/features/cart/model.ts' },
        'Shared code must not import a feature; move it into the feature or lift it to shared.',
      ],
    ]);
  });

  it('preset rule instances carry the project id and project-scoped selectors', () => {
    const { effective } = effectiveFor('preset-projects');
    expect(
      effective.instances.map((instance) => [
        instance.projectId,
        instance.rule.id,
        instance.rule.severity,
        instance.scope,
        instance.origin,
      ]),
    ).toEqual([
      ['proj:(repo)', 'node/no-cycles', 'warn', 'project', 'preset'],
      ['proj:apps/api', 'nest/layers', 'off', 'project', 'preset'],
      ['proj:apps/api', 'node/no-cycles', 'warn', 'project', 'preset'],
      ['proj:apps/web', 'node/no-cycles', 'warn', 'project', 'preset'],
      ['proj:apps/web', 'react/shared-no-feature-import', 'off', 'project', 'preset'],
    ]);
    expect(
      instanceOf(effective, 'proj:apps/web', 'react/shared-no-feature-import').rule,
    ).toMatchObject({
      from: ['apps/web/src/{components,lib,shared,utils}/**'],
      to: ['apps/web/src/features/**'],
    });
    expect(instanceOf(effective, 'proj:apps/api', 'nest/layers').rule).toMatchObject({
      layers: {
        controller: ['apps/api/**/*.controller.ts'],
        service: ['apps/api/**/*.service.ts'],
        repository: ['apps/api/**/*.repository.ts'],
        dto: ['apps/api/**/*.dto.ts'],
      },
    });

    const evaluation = check('preset-projects', [
      { id: 'nest/layers', severity: 'warn' },
      { id: 'react/shared-no-feature-import', severity: 'error' },
    ]);
    expect(summary(evaluation)).toEqual([
      [
        'proj:apps/api',
        'nest/layers',
        'warn',
        'apps/api/src/users/users.controller.ts',
        2,
        { file: 'apps/api/src/users/users.repository.ts' },
        'Controllers call services, not repositories.',
      ],
      [
        'proj:apps/web',
        'react/shared-no-feature-import',
        'error',
        'apps/web/src/shared/format.ts',
        1,
        { file: 'apps/web/src/features/cart/model.ts' },
        'Shared code must not import a feature; move it into the feature or lift it to shared.',
      ],
    ]);
  });

  it('a severity override reaches every instance with that id; one that reaches none warns', () => {
    const { effective } = effectiveFor('preset-projects', {
      rules: [
        { id: 'node/no-cycles', severity: 'error' },
        { id: 'next/client-server-boundary', severity: 'off' },
      ],
    });
    const cycles = effective.instances.filter((instance) => instance.rule.id === 'node/no-cycles');
    expect(cycles.map((instance) => instance.rule.severity)).toEqual(['error', 'error', 'error']);
    expect(effective.warnings).toEqual([
      'rule next/client-server-boundary: no active preset has a rule with this id; the severity override does nothing',
    ]);
  });

  it('user rules have repository scope; a user rule may not reuse an active preset rule id', () => {
    const rule = { type: 'no-cycles', id: 'NO-CYCLE-001', level: 'component' } as const;
    const { effective } = effectiveFor('nest-cjs', { rules: [rule] });
    expect(effective.instances).toContainEqual({
      rule,
      projectId: 'proj:(repo)',
      scope: 'repo',
      origin: 'user',
    });

    expect(() =>
      effectiveFor('nest-cjs', {
        rules: [{ type: 'no-cycles', id: 'nest/layers', level: 'file' }],
      }),
    ).toThrow(
      'Rule id nest/layers belongs to a preset rule. Use { "id": "nest/layers", "severity": ... } to change its severity, or pick another id.',
    );
  });

  it('several presets reaching one rule make one instance; repo rules are evaluated once at proj:(repo)', () => {
    const shared = definePreset({
      name: 'shared',
      detect: () => true,
      rules: [{ type: 'no-cycles', id: 'shared/no-cycles', level: 'component' }],
      repoRules: [{ type: 'no-cycles', id: 'shared/packages', level: 'package', severity: 'warn' }],
    });
    const wrapper = definePreset({ name: 'wrapper', detect: () => true, extends: ['shared'] });
    const { ctx } = buildFixtureParts('preset-projects');
    const presets = new Map(
      ctx.projects.map((project) => [project.id, [builtInPresets.node, shared, wrapper, shared]]),
    );
    const { instances } = mergeConfig(userConfig(), presets, ctx);

    expect(instances.filter((instance) => instance.rule.id === 'shared/no-cycles')).toHaveLength(3);
    expect(
      instances
        .filter((instance) => instance.rule.id === 'shared/packages')
        .map((instance) => [instance.projectId, instance.scope, instance.rule.severity]),
    ).toEqual([['proj:(repo)', 'repo', 'warn']]);
  });

  it('typeOnly, metrics and resolve come from the user; preset ignoreUnresolved is rebased', () => {
    const generated = definePreset({
      name: 'generated',
      detect: () => true,
      ignoreUnresolved: ['**/generated/**'],
    });
    const { ctx } = buildFixtureParts('preset-projects');
    const web = ctx.projects.find((project) => project.id === 'proj:apps/web')!;
    const user = userConfig({
      typeOnly: 'syntax',
      metrics: { abstractness: 'jdepend' },
      resolve: { aliases: { '@x': 'src/x.ts' }, ignoreUnresolved: ['virtual:*'] },
    });
    const effective = mergeConfig(user, new Map([[web.id, [builtInPresets.node, generated]]]), ctx);

    expect(effective.typeOnly).toBe('syntax');
    expect(effective.metrics).toEqual(user.metrics);
    expect(effective.resolve).toEqual({
      aliases: { '@x': 'src/x.ts' },
      virtual: [],
      ignoreUnresolved: ['virtual:*', 'apps/web/**/generated/**'],
    });
  });
});
