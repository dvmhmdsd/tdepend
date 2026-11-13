import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectFiles, type CollectResult } from '../../files/collectFiles';
import type { FileSystemLike } from '../../fs';
import { buildFileGraph, type BuildGraphResult } from '../../graph/buildFileGraph';
import type { FileEdge } from '../../graph/fileGraph';
import type { Compiler } from '../../parser/loadsTarget';
import type { EdgeKind } from '../../parser/types';
import { builtInPresets } from '../../presets';
import { discoverProject } from '../../project/discoverProject';
import type { ProjectContext } from '../../project/types';
import { createResolver } from '../../resolver/createResolver';
import type { ResolveOptions, Resolver } from '../../resolver/types';

export const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

// The skips every project gets, whatever else its presets add.
export const NODE_SKIPS = builtInPresets.node.skips ?? [];

export type EdgeTuple = [string, string, EdgeKind[], boolean];

export interface FixtureOptions {
  root?: string;
  resolve?: Partial<ResolveOptions>;
  typeOnly?: 'usage' | 'syntax';
  compilers?: Compiler[];
  fs?: FileSystemLike;
}

export interface FixtureParts extends BuildGraphResult {
  ctx: ProjectContext;
  files: CollectResult;
  resolver: Resolver;
}

export function buildFixture(name: string, options: FixtureOptions = {}): BuildGraphResult {
  const { graph, sites, report, parsed } = buildFixtureParts(name, options);
  return { graph, sites, report, parsed };
}

export function buildFixtureParts(name: string, options: FixtureOptions = {}): FixtureParts {
  const root = options.root ?? join(FIXTURES, name);
  const ctx = discoverProject(root, { fs: options.fs });
  const files = collectFiles(ctx, {
    include: [],
    exclude: [],
    presetSkips: NODE_SKIPS,
    fs: options.fs,
  });
  const resolver = createResolver(
    ctx,
    new Set(files.files),
    { aliases: {}, virtual: [], ignoreUnresolved: [], ...options.resolve },
    options.fs,
  );
  const built = buildFileGraph(ctx, files, resolver, options.typeOnly ?? 'usage', {
    compilers: options.compilers,
    fs: options.fs,
  });

  return { ...built, ctx, files, resolver };
}

export function kindsOf(edge: FileEdge): EdgeKind[] {
  return [...new Set(edge.sites.map((site) => site.kind))].sort();
}

export function edgeTuples(result: BuildGraphResult): EdgeTuple[] {
  return result.graph.edges().map((edge) => [edge.from, edge.to, kindsOf(edge), edge.runtime]);
}

export function expectedEdges(name: string): EdgeTuple[] {
  const path = join(FIXTURES, name, 'expected-edges.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as EdgeTuple[];
}
