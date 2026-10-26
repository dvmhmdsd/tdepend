import { join } from 'node:path';

import type * as ts from 'typescript';

import { ParseError } from '../errors';
import { nodeFileSystem, type FileSystemLike } from '../fs';
import type { CollectResult } from '../files/collectFiles';
import { parseFile } from '../parser/extractSites';
import { classifyLoads, type Compiler } from '../parser/loadsTarget';
import type { ImportSite, ParsedFile } from '../parser/types';
import type { ProjectContext } from '../project/types';
import { posixDirname, posixJoin } from '../resolver/workspaceHost';
import type { Resolution, ResolutionClass, Resolver } from '../resolver/types';
import { FileGraph, type FileEdge } from './fileGraph';

export const DEFAULT_COMPILERS: Compiler[] = ['tsc', 'esbuild', 'swc'];

const RESOLUTION_CLASSES: ResolutionClass[] = [
  'builtin',
  'asset',
  'virtual',
  'internal',
  'workspace',
  'excluded',
  'external',
  'ignored',
  'unsupported',
  'unresolved',
];

export interface SiteRecord {
  file: string;
  site: ImportSite;
  resolution: Resolution;
}

export interface ResolutionReport {
  stats: Record<ResolutionClass, number>;
  unresolved: SiteRecord[];
  ignoredByDir: Record<string, number>;
  unsupported: SiteRecord[];
  selfImports: string[];
  uncovered: string[];
  skipped: CollectResult['skipped'];
}

export interface BuildGraphResult {
  graph: FileGraph;
  sites: SiteRecord[];
  report: ResolutionReport;
  parsed: Map<string, ParsedFile>;
}

export interface BuildGraphOptions {
  compilers?: Compiler[];
  fs?: FileSystemLike;
}

// Everything the per-site pass accumulates, so one site can be classified,
// resolved and recorded without threading a dozen locals through the loop.
interface SiteCollector {
  stats: Record<ResolutionClass, number>;
  unresolved: SiteRecord[];
  unsupported: SiteRecord[];
  ignoredByDir: Map<string, number>;
  selfImports: Set<string>;
  edges: Map<string, FileEdge>;
}

// The per-file context a site is judged against.
interface SiteEnvironment {
  resolver: Resolver;
  typeOnly: 'usage' | 'syntax';
  compilers: Compiler[];
  file: string;
  parsedFile: ParsedFile;
  compilerOptions: ts.CompilerOptions;
}

export function buildFileGraph(
  ctx: ProjectContext,
  files: CollectResult,
  resolver: Resolver,
  typeOnly: 'usage' | 'syntax',
  options: BuildGraphOptions = {},
): BuildGraphResult {
  const fs = options.fs ?? nodeFileSystem();
  const compilers = options.compilers ?? DEFAULT_COMPILERS;
  const parsed = new Map<string, ParsedFile>();
  const sites: SiteRecord[] = [];
  const collector = emptyCollector();

  for (const file of files.files) {
    const { options: compilerOptions } = ctx.optionsFor(file);
    const parsedFile = parseFile(file, readSourceFile(fs, ctx.rootDir, file), compilerOptions);
    parsed.set(file, parsedFile);

    const environment: SiteEnvironment = {
      resolver,
      typeOnly,
      compilers,
      file,
      parsedFile,
      compilerOptions,
    };
    for (const site of parsedFile.sites) {
      sites.push(collectSite(collector, environment, site));
    }
  }

  return {
    graph: new FileGraph(files.files, [...collector.edges.values()]),
    sites,
    report: buildReport(collector, files),
    parsed,
  };
}

// Classifies how a site loads, resolves it, and files the result under the class
// it landed in, adding a graph edge only when the site names an analysed file.
function collectSite(
  collector: SiteCollector,
  environment: SiteEnvironment,
  site: ImportSite,
): SiteRecord {
  const { parsedFile, compilerOptions, typeOnly, compilers, resolver, file } = environment;

  const verdict = classifyLoads(parsedFile, site, compilerOptions, typeOnly, compilers);
  site.loadsTarget = verdict.loadsTarget;
  site.loadsTargetBy = verdict.loadsTargetBy;
  site.loadReason = verdict.reason;

  const resolution = resolver.resolve(site, parsedFile);
  const record: SiteRecord = { file, site, resolution };
  collector.stats[resolution.class] += 1;

  if (resolution.class === 'unresolved') collector.unresolved.push(record);
  if (resolution.class === 'unsupported') collector.unsupported.push(record);
  if (resolution.class === 'ignored' && resolution.reason === 'gitignored') {
    recordIgnoredDirectory(collector.ignoredByDir, file, site.specifier);
  }

  addGraphEdge(collector, file, site, resolution);
  return record;
}

function addGraphEdge(
  collector: SiteCollector,
  file: string,
  site: ImportSite,
  resolution: Resolution,
): void {
  const target = edgeTarget(resolution);
  if (target === null) return;
  if (target === file) {
    collector.selfImports.add(file);
    return;
  }
  mergeEdge(collector.edges, file, target, site, resolution);
}

function recordIgnoredDirectory(
  ignoredByDir: Map<string, number>,
  file: string,
  specifier: string,
): void {
  const dir = targetDirectory(file, specifier);
  if (dir === null) return;
  ignoredByDir.set(dir, (ignoredByDir.get(dir) ?? 0) + 1);
}

function buildReport(collector: SiteCollector, files: CollectResult): ResolutionReport {
  return {
    stats: collector.stats,
    unresolved: collector.unresolved,
    ignoredByDir: Object.fromEntries([...collector.ignoredByDir.entries()].sort()),
    unsupported: collector.unsupported,
    selfImports: [...collector.selfImports].sort(),
    uncovered: files.uncovered,
    skipped: files.skipped,
  };
}

function emptyCollector(): SiteCollector {
  return {
    stats: emptyStats(),
    unresolved: [],
    unsupported: [],
    ignoredByDir: new Map(),
    selfImports: new Set(),
    edges: new Map(),
  };
}

function emptyStats(): Record<ResolutionClass, number> {
  const stats = {} as Record<ResolutionClass, number>;
  for (const resolutionClass of RESOLUTION_CLASSES) stats[resolutionClass] = 0;
  return stats;
}

// A collected file that cannot be read makes the whole analysis incomplete: its
// imports would silently vanish from the graph. Fail loudly instead of skipping.
function readSourceFile(fs: FileSystemLike, rootDir: string, file: string): string {
  try {
    return fs.readFile(join(rootDir, file));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ParseError(`Cannot read source file ${file}: ${reason}`, file);
  }
}

// Only the resolved-file classes that carry a graph edge. An `excluded` target
// keeps its file for selectors, but it adds no edge.
function edgeTarget(resolution: Resolution): string | null {
  if (resolution.class !== 'internal' && resolution.class !== 'workspace') return null;
  const target = resolution.target;
  if (target === null || !('file' in target)) return null;
  return target.file;
}

function mergeEdge(
  edges: Map<string, FileEdge>,
  from: string,
  to: string,
  site: ImportSite,
  resolution: Resolution,
): void {
  const key = `${from}\u0000${to}`;
  const existing = edges.get(key);
  if (existing !== undefined) {
    existing.sites.push(site);
    existing.runtime = existing.runtime || site.loadsTarget === true;
    existing.mapped = existing.mapped || resolution.mapped !== undefined;
    return;
  }
  edges.set(key, {
    from,
    to,
    sites: [site],
    runtime: site.loadsTarget === true,
    mapped: resolution.mapped !== undefined,
  });
}

function targetDirectory(file: string, specifier: string): string | null {
  const target = posixJoin(posixDirname(file), specifier);
  const dir = posixDirname(target);
  if (dir === '' || dir.startsWith('..')) return null;
  return `${dir}/`;
}
