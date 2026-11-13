import type { ComponentStrategy, CoverageConfig } from '../components/types';
import type { UserConfig } from '../config/schema';
import { ConfigError } from '../errors';
import type { Project, ProjectContext } from '../project/types';
import type { ResolveOptions } from '../resolver/types';
import { userRuleInstances } from '../rules/evaluateRules';
import {
  REPO_SCOPE,
  type RuleDefinition,
  type RuleInstance,
  type RuleOverride,
  type Severity,
  type TargetSelector,
} from '../rules/types';
import type { Preset } from './definePreset';
import { COMPONENT_PRECEDENCE, builtInPresets } from './registry';

export interface EffectiveConfig {
  // Root-relative preset skips, without the ones a user `!` entry removed.
  skips: string[];
  exclude: string[];
  resolve: ResolveOptions;
  strategyFor(project: Project): ComponentStrategy;
  coverage?: CoverageConfig;
  instances: RuleInstance[];
  typeOnly: UserConfig['typeOnly'];
  metrics: UserConfig['metrics'];
  warnings: string[];
}

interface ProjectPresets {
  project: Project;
  presets: Preset[];
}

export function mergeConfig(
  user: UserConfig,
  presets: Map<string, Preset[]>,
  ctx: ProjectContext,
): EffectiveConfig {
  const entries = ctx.projects.map((project) => ({
    project,
    presets: presets.get(project.id) ?? [],
  }));
  const userInstances = userRuleInstances(user.rules);
  const fromPresets = presetInstances(entries);
  rejectPresetIds(userInstances, fromPresets);
  const { instances, warnings } = applyOverrides(fromPresets, user.rules);

  const strategies = new Map(
    entries.map(({ project, presets }) => [project.id, strategyOf(presets)]),
  );
  const userStrategy = user.components === undefined ? undefined : withoutCoverage(user.components);
  const fallback = builtInPresets.node.components as ComponentStrategy;

  return {
    skips: effectiveSkips(entries, user.exclude, ctx),
    exclude: user.exclude,
    resolve: {
      aliases: user.resolve.aliases,
      virtual: user.resolve.virtual,
      ignoreUnresolved: unique([
        ...user.resolve.ignoreUnresolved,
        ...presetGlobs(entries, (preset) => preset.ignoreUnresolved),
      ]),
    },
    strategyFor: (project) => userStrategy ?? strategies.get(project.id) ?? fallback,
    coverage:
      user.components !== undefined && 'coverage' in user.components
        ? user.components.coverage
        : undefined,
    instances: [...userInstances, ...instances].sort(compareInstances),
    typeOnly: user.typeOnly,
    metrics: user.metrics,
    warnings,
  };
}

// A preset's globs are relative to its project; rules need them root-relative.
function rebase(glob: string, dir: string): string {
  if (dir === '') return glob;
  return glob.startsWith('!') ? `!${dir}/${glob.slice(1)}` : `${dir}/${glob}`;
}

function presetGlobs(
  entries: ProjectPresets[],
  pick: (preset: Preset) => string[] | undefined,
): string[] {
  return entries.flatMap(({ project, presets }) =>
    presets.flatMap((preset) => (pick(preset) ?? []).map((glob) => rebase(glob, project.dir))),
  );
}

// A user `!pattern` switches a preset skip off in every project, so it names
// the pattern as presets write it rather than each project's rebased copy.
function effectiveSkips(
  entries: ProjectPresets[],
  exclude: string[],
  ctx: ProjectContext,
): string[] {
  const removed = new Set(
    exclude
      .filter((pattern) => pattern.startsWith('!'))
      .flatMap((pattern) => ctx.projects.map((project) => rebase(pattern.slice(1), project.dir))),
  );
  const skips = unique(presetGlobs(entries, (preset) => preset.skips));
  return skips.filter((skip) => !removed.has(skip));
}

// One instance per project and rule id, however many presets reach it.
// Recommended rules ship off; repository rules are evaluated once.
function presetInstances(entries: ProjectPresets[]): RuleInstance[] {
  const instances = new Map<string, RuleInstance>();
  const add = (key: string, instance: RuleInstance): void => {
    if (!instances.has(key)) instances.set(key, instance);
  };

  for (const { project, presets } of entries) {
    const inProject = (rule: RuleDefinition, severity: Severity): void =>
      add(`${project.id}\u0000${rule.id}`, {
        rule: { ...rebaseRule(rule, project.dir), severity },
        projectId: project.id,
        scope: 'project',
        origin: 'preset',
      });
    for (const preset of presets) {
      for (const rule of preset.rules ?? []) inProject(rule, rule.severity ?? 'error');
      for (const rule of preset.recommended ?? []) inProject(rule, 'off');
      for (const rule of preset.repoRules ?? []) {
        add(`\u0000repo\u0000${rule.id}`, {
          rule: { ...rule, severity: rule.severity ?? 'error' },
          projectId: REPO_SCOPE,
          scope: 'repo',
          origin: 'preset',
        });
      }
    }
  }
  return [...instances.values()];
}

function rebaseRule(rule: RuleDefinition, dir: string): RuleDefinition {
  const globs = (list: string[]): string[] => list.map((glob) => rebase(glob, dir));
  const selector = (target: TargetSelector): TargetSelector =>
    target.files === undefined ? target : { ...target, files: globs(target.files) };

  switch (rule.type) {
    case 'forbidden': {
      const rebased = {
        ...rule,
        from: globs(rule.from),
        to: Array.isArray(rule.to) ? globs(rule.to) : selector(rule.to),
      };
      if (rule.exceptFrom !== undefined) rebased.exceptFrom = globs(rule.exceptFrom);
      if (rule.exceptTo !== undefined) rebased.exceptTo = selector(rule.exceptTo);
      return rebased;
    }
    case 'layers':
      return {
        ...rule,
        layers: Object.fromEntries(
          Object.entries(rule.layers).map(([name, list]) => [name, globs(list)]),
        ),
      };
    case 'private':
      // `paths` and `public` are relative to each component, not the project.
      return rule.exceptFrom === undefined ? rule : { ...rule, exceptFrom: globs(rule.exceptFrom) };
    case 'no-cycles':
      return rule;
  }
}

// A preset rule keeps its id in every report, so a user rule can't take it.
function rejectPresetIds(userInstances: RuleInstance[], fromPresets: RuleInstance[]): void {
  const presetIds = new Set(fromPresets.map((instance) => instance.rule.id));
  const taken = userInstances.find((instance) => presetIds.has(instance.rule.id));
  if (taken !== undefined) {
    const id = taken.rule.id;
    throw new ConfigError(
      `Rule id ${id} belongs to a preset rule. Use { "id": "${id}", "severity": ... } to change its severity, or pick another id.`,
    );
  }
}

// `{ id, severity }` changes every preset instance with that id.
function applyOverrides(
  instances: RuleInstance[],
  rules: UserConfig['rules'],
): { instances: RuleInstance[]; warnings: string[] } {
  const overrides = rules.filter((rule): rule is RuleOverride => !('type' in rule));
  const severities = new Map(overrides.map((override) => [override.id, override.severity]));
  const present = new Set(instances.map((instance) => instance.rule.id));
  const warnings = overrides
    .filter((override) => !present.has(override.id))
    .map(
      (override) =>
        `rule ${override.id}: no active preset has a rule with this id; the severity override does nothing`,
    );

  return {
    instances: instances.map((instance) => {
      const severity = severities.get(instance.rule.id);
      return severity === undefined
        ? instance
        : { ...instance, rule: { ...instance.rule, severity } };
    }),
    warnings,
  };
}

function strategyOf(presets: Preset[]): ComponentStrategy | undefined {
  const rank = (preset: Preset): number =>
    builtInPresets[preset.name] === preset ? COMPONENT_PRECEDENCE.indexOf(preset.name) : -1;
  const candidates = presets.filter((preset) => preset.components !== undefined);
  // A stable sort keeps list order between presets of equal rank.
  return candidates.sort((left, right) => rank(left) - rank(right))[0]?.components;
}

function withoutCoverage(components: NonNullable<UserConfig['components']>): ComponentStrategy {
  switch (components.type) {
    case 'directory':
      return { type: 'directory', patterns: components.patterns };
    case 'nest-module':
      return { type: 'nest-module' };
    case 'file':
      return { type: 'file' };
  }
}

function compareInstances(left: RuleInstance, right: RuleInstance): number {
  return (
    compareText(left.projectId, right.projectId) ||
    compareText(left.rule.id, right.rule.id) ||
    compareText(left.scope, right.scope)
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}
