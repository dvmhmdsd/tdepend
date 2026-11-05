import type { SiteRecord } from '../graph/buildFileGraph';
import type { FileEdge } from '../graph/fileGraph';

export type ComponentStrategy =
  { type: 'directory'; patterns: string[] } | { type: 'nest-module' } | { type: 'file' };

export interface CoverageConfig {
  requireAll: boolean;
  allowUnmatched: string[];
}

export type GroupLevel = 'component' | 'package';

export interface Group {
  id: string;
  name: string;
  directory: string;
  projectId: string;
  packageId: string | null;
  level: GroupLevel;
}

export interface Assignment {
  componentOf: Map<string, Group>;
  packageOf: Map<string, Group | null>;
  components: Group[];
  packages: Group[];
  unassigned: string[];
  warnings: string[];
}

export interface GroupEdge {
  from: Group;
  to: Group;
  sites: SiteRecord[];
  fileEdges: FileEdge[];
  runtime: boolean;
}

export interface GroupGraph {
  level: GroupLevel;
  groups: Group[];
  edges: GroupEdge[];
  edgesFrom(group: Group): GroupEdge[];
  edgesTo(group: Group): GroupEdge[];
}
