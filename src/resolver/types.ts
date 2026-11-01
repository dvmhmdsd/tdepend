import type { ImportSite, ParsedFile } from '../parser/types';

export type ResolutionClass =
  | 'builtin'
  | 'asset'
  | 'virtual'
  | 'internal'
  | 'workspace'
  | 'excluded'
  | 'external'
  | 'ignored'
  | 'unsupported'
  | 'unresolved';

export type Target = { file: string } | { module: string };

export interface WorkspaceRequest {
  package: string;
  subpath: string;
}

export interface Resolution {
  class: ResolutionClass;
  target: Target | null;
  reason?: string;
  mapped?: { from: string };
  requested?: WorkspaceRequest;
}

export interface ResolveOptions {
  aliases: Record<string, string>;
  virtual: string[];
  ignoreUnresolved: string[];
}

export interface Resolver {
  resolve(site: ImportSite, parsed: ParsedFile): Resolution;
}
