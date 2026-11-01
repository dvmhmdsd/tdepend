import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SKIPS, collectFiles } from '../../files/collectFiles';
import type { FileSystemLike } from '../../fs';
import { buildFileGraph, type BuildGraphResult } from '../../graph/buildFileGraph';
import type { FileEdge } from '../../graph/fileGraph';
import type { Compiler } from '../../parser/loadsTarget';
import type { EdgeKind } from '../../parser/types';
import { discoverProject } from '../../project/discoverProject';
import { createResolver } from '../../resolver/createResolver';
import type { ResolveOptions } from '../../resolver/types';

export const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

export type EdgeTuple = [string, string, EdgeKind[], boolean];

export interface FixtureOptions {
  root?: string;
  resolve?: Partial<ResolveOptions>;
  typeOnly?: 'usage' | 'syntax';
  compilers?: Compiler[];
  fs?: FileSystemLike;
}

export function buildFixture(name: string, options: FixtureOptions = {}): BuildGraphResult {
  const root = options.root ?? join(FIXTURES, name);
  const ctx = discoverProject(root, { fs: options.fs });
  const files = collectFiles(ctx, {
    include: [],
    exclude: [],
    presetSkips: DEFAULT_SKIPS,
    fs: options.fs,
  });
  const resolver = createResolver(
    ctx,
    new Set(files.files),
    { aliases: {}, virtual: [], ignoreUnresolved: [], ...options.resolve },
    options.fs,
  );

  return buildFileGraph(ctx, files, resolver, options.typeOnly ?? 'usage', {
    compilers: options.compilers,
    fs: options.fs,
  });
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
