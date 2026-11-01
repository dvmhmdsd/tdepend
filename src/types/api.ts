import type { UserConfig } from '../config/schema';
import type { CollectResult, SkipReason } from '../files/collectFiles';
import type { ResolutionReport, SiteRecord } from '../graph/buildFileGraph';
import type { FileGraph } from '../graph/fileGraph';
import type { EdgeKind, LoadReason, SiteForm, UnsupportedReason } from '../parser/types';
import type { ProjectContext } from '../project/types';
import type { ResolutionClass, Target, WorkspaceRequest } from '../resolver/types';

/**
 * The live result an analysis returns. It holds rich objects (the project
 * context with its lookup functions, parsed files and resolver nodes) that are
 * not serialisable, so `toSerializable` projects it into the export shape.
 */
export interface AnalysisResult {
  ctx: ProjectContext;
  files: CollectResult;
  graph: FileGraph;
  sites: SiteRecord[];
  report: ResolutionReport;
  config: UserConfig;
}

/** One import site in the versioned JSON export. */
export interface SerializableSite {
  file: string;
  specifier: string;
  line: number;
  column: number;
  kind: EdgeKind;
  form: SiteForm;
  deferred: boolean;
  unsupported: UnsupportedReason | null;
  loadsTarget: boolean;
  loadsTargetBy: LoadReason | null;
  class: ResolutionClass;
  target: Target | null;
  mapped: string | null;
  requested: WorkspaceRequest | null;
}

/** One edge of the file graph: the pair, its runtime/mapped flags and kinds. */
export interface SerializableEdge {
  from: string;
  to: string;
  runtime: boolean;
  mapped: boolean;
  kinds: EdgeKind[];
}

/** A site reduced to where it is and what it names. */
export interface SerializableSiteLocation {
  file: string;
  line: number;
  column: number;
  specifier: string;
}

/** An unsupported site with the reason it could not be classified. */
export interface SerializableUnsupported extends SerializableSiteLocation {
  reason: string;
}

export interface SerializableReport {
  stats: Record<ResolutionClass, number>;
  unresolved: SerializableSiteLocation[];
  ignoredByDir: Record<string, number>;
  unsupported: SerializableUnsupported[];
  selfImports: string[];
  uncovered: string[];
  skipped: Array<{ file: string; reason: SkipReason }>;
}

/**
 * The versioned JSON export. It carries data only, is fully sorted and has no
 * timestamp, so two runs on the same inputs produce byte-identical output.
 */
export interface SerializableResult {
  version: 1;
  files: string[];
  edges: SerializableEdge[];
  sites: SerializableSite[];
  report: SerializableReport;
}
