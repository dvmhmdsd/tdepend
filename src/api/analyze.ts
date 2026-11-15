import { dirname, resolve as resolvePath } from 'node:path';

import { assignComponents } from '../components/assignComponents';
import { buildGroupGraph, groupLookup } from '../components/groupGraph';
import type { GroupLevel } from '../components/types';
import { loadConfig } from '../config/loadConfig';
import { CycleCache, findCycles, groupCycleGraph, type Cycle } from '../cycles/findCycles';
import { ConfigError } from '../errors';
import { collectFiles, createExcludeMatcher } from '../files/collectFiles';
import { isDir, nodeFileSystem } from '../fs';
import { buildFileGraph } from '../graph/buildFileGraph';
import { eraseTypeReexports } from '../graph/eraseTypeReexports';
import { computeMetrics } from '../metrics/computeMetrics';
import { mergeConfig } from '../presets/mergeConfig';
import { builtInPresets } from '../presets/registry';
import { resolvePresets } from '../presets/resolvePresets';
import { discoverProject } from '../project/discoverProject';
import { createResolver } from '../resolver/createResolver';
import { buildSymbolIndex } from '../symbols/symbolIndex';
import type { AnalysisResult, GroupCycle } from '../types/api';

export interface AnalyzeOptions {
  /** Root directory to analyse. Defaults to the current working directory. */
  root?: string;
  /** Path to the tdepend config file. Discovered under the root when omitted. */
  config?: string;
  /** Overrides the config's type-only detection for this run. */
  typeOnly?: 'usage' | 'syntax';
}

/**
 * Runs the whole pipeline once: discover projects, packages and tsconfigs,
 * pick each project's presets, collect the analysis set, parse and resolve
 * every import site, build the file graph, assign components and packages,
 * index the symbols, and compute metrics and group cycles.
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const baseDir = resolvePath(options.root ?? process.cwd());
  const { config, configFile } = loadConfig({ cwd: baseDir, configPath: options.config });
  const rootDir = config.root === '.' ? baseDir : resolvePath(baseDir, config.root);
  if (!isDir(nodeFileSystem(), rootDir)) {
    throw new ConfigError(`Root directory not found: ${rootDir}`);
  }
  const configDir = configFile === null ? baseDir : dirname(configFile);

  // Presets are chosen per project, so discovery can only use the skips every
  // project gets.
  const ctx = discoverProject(rootDir, {
    isExcluded: createExcludeMatcher(builtInPresets.node.skips ?? [], config.exclude),
    isConfigExcluded: createExcludeMatcher([], config.exclude),
  });
  const effective = mergeConfig(config, resolvePresets(config.presets, ctx, configDir), ctx);
  const files = collectFiles(ctx, {
    include: config.include,
    exclude: effective.exclude,
    presetSkips: effective.skips,
  });
  const resolver = createResolver(ctx, new Set(files.files), effective.resolve);
  const parsedGraph = buildFileGraph(ctx, files, resolver, options.typeOnly ?? effective.typeOnly, {
    compilers: config.compilers,
  });
  const index = buildSymbolIndex(parsedGraph.graph, parsedGraph.parsed, parsedGraph.sites);
  const built = eraseTypeReexports(parsedGraph, index, config.compilers);

  const assignment = assignComponents(ctx, built.graph.files(), effective.strategyFor);
  const component = buildGroupGraph(built.graph, assignment, 'component', built.sites);
  const groups =
    assignment.packages.length === 0
      ? { component }
      : { component, package: buildGroupGraph(built.graph, assignment, 'package', built.sites) };
  const cycleCache = new CycleCache();
  const groupCycles = (level: GroupLevel): GroupCycle[] => {
    const cycleGraph = groupCycleGraph(built.graph, built.sites, groupLookup(assignment, level));
    const cycles: Cycle[] = findCycles(
      { level, graphId: built.graph.id, scopeId: 'repo', ...cycleGraph },
      { ignoreTypeOnly: true, ignoreLazyImports: false },
      cycleCache,
    );
    return cycles.map((cycle) => ({ ...cycle, names: cycle.members.map(cycleGraph.nameOf) }));
  };

  return {
    ctx,
    files,
    graph: built.graph,
    sites: built.sites,
    report: built.report,
    config,
    configDir,
    effective,
    assignment,
    groups,
    index,
    metrics: computeMetrics(built.graph, groups, index, effective.metrics.abstractness),
    cycles: {
      component: groupCycles('component'),
      package: groups.package === undefined ? [] : groupCycles('package'),
    },
    cycleCache,
  };
}
