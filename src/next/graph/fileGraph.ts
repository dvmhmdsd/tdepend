import { createHash } from 'node:crypto';

import type { EdgeKind, ImportSite } from '../parser/types';

export interface FileEdge {
  from: string;
  to: string;
  sites: ImportSite[];
  runtime: boolean;
  mapped: boolean;
}

// The file graph is the source every other level is aggregated from. Nodes are
// root-relative file paths and edges hold every site between two files.
export class FileGraph {
  readonly id: string;

  private readonly nodeList: string[];
  private readonly edgeList: FileEdge[];
  private readonly fromIndex: Map<string, FileEdge[]>;
  private readonly toIndex: Map<string, FileEdge[]>;

  constructor(files: string[], edges: FileEdge[]) {
    this.nodeList = [...files].sort();
    this.edgeList = [...edges].sort(compareEdges);
    this.fromIndex = indexBy(this.edgeList, (edge) => edge.from);
    this.toIndex = indexBy(this.edgeList, (edge) => edge.to);
    this.id = hashEdges(this.edgeList);
  }

  files(): string[] {
    return [...this.nodeList];
  }

  edges(): FileEdge[] {
    return [...this.edgeList];
  }

  edgesFrom(file: string): FileEdge[] {
    return [...(this.fromIndex.get(file) ?? [])];
  }

  edgesTo(file: string): FileEdge[] {
    return [...(this.toIndex.get(file) ?? [])];
  }
}

function compareEdges(a: FileEdge, b: FileEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return 0;
}

function indexBy(edges: FileEdge[], key: (edge: FileEdge) => string): Map<string, FileEdge[]> {
  const index = new Map<string, FileEdge[]>();
  for (const edge of edges) {
    const value = key(edge);
    const list = index.get(value);
    if (list === undefined) index.set(value, [edge]);
    else list.push(edge);
  }
  return index;
}

// A site's contribution to the identity: the properties cycle filtering reads.
// `loadsTarget` answers `ignoreTypeOnly` and picks the witness site; `deferred`
// answers `ignoreLazyImports`; `kind` decides whether a site is eligible at all.
type SiteSignature = [EdgeKind, boolean, boolean];

// Cache key for anything derived from the graph: the sorted edges plus the
// filter-relevant shape of their sites. A source edit that moves a site between
// filtering categories gets a new identity, so a cached cycle result is never
// reused across it. Line and column stay out on purpose: editing above an import
// must not churn the id.
function hashEdges(edges: FileEdge[]): string {
  const canonical = edges.map((edge) => [
    edge.from,
    edge.to,
    edge.runtime,
    edge.mapped,
    siteSignatures(edge.sites),
  ]);
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex');
}

function siteSignatures(sites: ImportSite[]): SiteSignature[] {
  return sites
    .map(
      (site): SiteSignature => [site.kind, site.loadsTarget === true, site.deferred === true],
    )
    .sort(compareSiteSignatures);
}

function compareSiteSignatures(a: SiteSignature, b: SiteSignature): number {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
