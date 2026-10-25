import type * as ts from 'typescript';

export type EdgeKind = 'static' | 'type' | 're-export' | 'dynamic' | 'require' | 'side-effect';

export type SiteForm = 'declaration' | 'type-context';

export type UnsupportedReason = 'non-literal' | 'shadowed-require' | 'jsdoc-import-type';

export type LoadReason = 'syntax' | 'usage' | 'retained';

export interface ImportBinding {
  local: string;
  imported: string | '*' | 'default';
  typeOnly: boolean;
}

export interface ImportSite {
  specifier: string;
  line: number;
  column: number;
  kind: EdgeKind;
  form: SiteForm;
  bindings: ImportBinding[];
  deferred?: boolean;
  unsupported?: UnsupportedReason;
  loadsTarget?: boolean;
  loadsTargetBy?: LoadReason;
  loadReason?: string;
  node: ts.Node;
}

export interface ParsedFile {
  file: string;
  sourceFile: ts.SourceFile;
  sites: ImportSite[];
  directives: string[];
}
