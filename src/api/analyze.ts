import { resolve as resolvePath } from 'node:path';

import { loadConfig } from '../config/loadConfig';
import { ConfigError } from '../errors';
import { DEFAULT_SKIPS, collectFiles, createExcludeMatcher } from '../files/collectFiles';
import { isDir, nodeFileSystem } from '../fs';
import { buildFileGraph } from '../graph/buildFileGraph';
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
 * collect the analysis set, parse every file's import sites, resolve each site
 * through TypeScript with a workspace host, and build the file graph.
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const baseDir = resolvePath(options.root ?? process.cwd());
  const { config } = loadConfig({ cwd: baseDir, configPath: options.config });
  const rootDir = config.root === '.' ? baseDir : resolvePath(baseDir, config.root);
  if (!isDir(nodeFileSystem(), rootDir)) {
    throw new ConfigError(`Root directory not found: ${rootDir}`);
  }

  const ctx = discoverProject(rootDir, {
    isExcluded: createExcludeMatcher(DEFAULT_SKIPS, config.exclude),
    isConfigExcluded: createExcludeMatcher([], config.exclude),
  });
  const files = collectFiles(ctx, {
    include: config.include,
    exclude: config.exclude,
    presetSkips: DEFAULT_SKIPS,
  });
  const resolver = createResolver(ctx, new Set(files.files), config.resolve);
  const built = buildFileGraph(ctx, files, resolver, options.typeOnly ?? config.typeOnly, {
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
