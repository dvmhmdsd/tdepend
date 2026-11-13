import { dirname, resolve as resolvePath } from 'node:path';

import { loadConfig } from '../config/loadConfig';
import { ConfigError } from '../errors';
import { collectFiles, createExcludeMatcher } from '../files/collectFiles';
import { isDir, nodeFileSystem } from '../fs';
import { buildFileGraph } from '../graph/buildFileGraph';
import { mergeConfig } from '../presets/mergeConfig';
import { builtInPresets } from '../presets/registry';
import { resolvePresets } from '../presets/resolvePresets';
import { discoverProject } from '../project/discoverProject';
import { createResolver } from '../resolver/createResolver';
import type { AnalysisResult } from '../types/api';

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
 * pick each project's presets, collect the analysis set, parse every file's
 * import sites, resolve each site through TypeScript with a workspace host,
 * and build the file graph.
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const baseDir = resolvePath(options.root ?? process.cwd());
  const { config, configFile } = loadConfig({ cwd: baseDir, configPath: options.config });
  const rootDir = config.root === '.' ? baseDir : resolvePath(baseDir, config.root);
  if (!isDir(nodeFileSystem(), rootDir)) {
    throw new ConfigError(`Root directory not found: ${rootDir}`);
  }

  // Presets are chosen per project, so discovery can only use the skips every
  // project gets.
  const ctx = discoverProject(rootDir, {
    isExcluded: createExcludeMatcher(builtInPresets.node.skips ?? [], config.exclude),
    isConfigExcluded: createExcludeMatcher([], config.exclude),
  });
  const presets = resolvePresets(
    config.presets,
    ctx,
    configFile === null ? baseDir : dirname(configFile),
  );
  const effective = mergeConfig(config, presets, ctx);
  const files = collectFiles(ctx, {
    include: config.include,
    exclude: effective.exclude,
    presetSkips: effective.skips,
  });
  const resolver = createResolver(ctx, new Set(files.files), effective.resolve);
  const built = buildFileGraph(ctx, files, resolver, options.typeOnly ?? effective.typeOnly, {
    compilers: config.compilers,
  });

  return {
    ctx,
    files,
    graph: built.graph,
    sites: built.sites,
    report: built.report,
    config,
  };
}
