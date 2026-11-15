import type { Assignment, GroupGraph, GroupLevel } from '../components/types';
import type { UserConfig } from '../config/schema';
import type { Cycle, CycleCache, CycleLevel } from '../cycles/findCycles';
import type { CollectResult, SkipReason } from '../files/collectFiles';
import type { ResolutionReport, SiteRecord } from '../graph/buildFileGraph';
import type { FileGraph } from '../graph/fileGraph';
import type { MetricsByLevel } from '../metrics/computeMetrics';
import type { EdgeKind, LoadReason, SiteForm, UnsupportedReason } from '../parser/types';
import type { EffectiveConfig } from '../presets/mergeConfig';
import type { ProjectContext } from '../project/types';
import type { ResolutionClass, Target, WorkspaceRequest } from '../resolver/types';
import type { RuleDefinition, SiteData } from '../rules/types';
import type { SymbolIndex } from '../symbols/types';

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
  /** The folder relative paths in the config are read from. */
  configDir: string;
  effective: EffectiveConfig;
  assignment: Assignment;
  groups: { component: GroupGraph; package?: GroupGraph };
  index: SymbolIndex;
  metrics: MetricsByLevel;
  /** Component and package cycles that load at runtime, for the report. */
  cycles: { component: GroupCycle[]; package: GroupCycle[] };
  cycleCache: CycleCache;
}

/** A group cycle with each member's display name, in member order. */
export interface GroupCycle extends Cycle {
  names: string[];
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
  reason: string | null;
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
  warnings: string[];
}

/**
 * The versioned JSON export. It carries data only, is fully sorted and has no
 * timestamp, so two runs on the same inputs produce byte-identical output.
 */
export interface SerializableResult {
  version: 2;
  files: string[];
  edges: SerializableEdge[];
  sites: SerializableSite[];
  components: SerializableGroup[];
  packages: SerializableGroup[];
  metrics: MetricsByLevel;
  cycles: { component: SerializableCycle[]; package: SerializableCycle[] };
  rules: SerializableRuleInstance[];
  report: SerializableReport;
}

/** A component or package with its typed id and its files. */
export interface SerializableGroup {
  id: string;
  name: string;
  directory: string;
  projectId: string;
  packageId: string | null;
  level: GroupLevel;
  files: string[];
}

export interface SerializableCycle {
  level: CycleLevel;
  members: string[];
  names: string[];
  optimal: boolean;
  hops: Array<{ fromGroup: string; toGroup: string; fromFile: string; to: Target; site: SiteData }>;
}

/** One effective rule instance: what the merge of presets and config produced. */
export interface SerializableRuleInstance {
  id: string;
  projectId: string;
  scope: 'repo' | 'project';
  origin: 'user' | 'preset';
  severity: 'error' | 'warn' | 'off';
  rule: RuleDefinition;
}
