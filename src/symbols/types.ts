export type DeclKind =
  | 'class'
  | 'abstract-class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'variable'
  | 'default-expression'
  | 'cjs-export';

export interface Declaration {
  id: string;
  file: string;
  name: string;
  kind: DeclKind;
  exported: boolean;
}

export type UnresolvedReason = 'ambiguous' | 'external' | 'missing' | 'computed';

export type HeritageClause = 'implements' | 'extends';

export interface HeritageRef {
  from: Declaration;
  clause: HeritageClause;
  name: string;
  resolved: Declaration | null;
  unresolvedReason?: UnresolvedReason;
}

export interface ExportInfo {
  name: string;
  declaration: Declaration | null;
  reexportFrom?: string;
  isAsyncFunction: boolean;
}

export interface SymbolIndex {
  declarations(file: string): Declaration[];
  exports(file: string): ExportInfo[];
  heritage(): HeritageRef[];
  excludedHeritage(): HeritageRef[];
  resolveExport(file: string, name: string): Declaration | null;
  unresolvedHeritageCount: number;
}
