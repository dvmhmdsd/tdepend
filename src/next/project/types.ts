import type * as ts from 'typescript';

export interface FileSystemLike {
  readFile(path: string): string;
  readdir(path: string): string[];
  stat(path: string): { isFile(): boolean; isDirectory(): boolean };
  realpath(path: string): string;
}

export interface TsconfigEntry {
  configPath: string;
  options: ts.CompilerOptions;
  fileNames: Set<string>;
  outDir?: string;
  declarationDir?: string;
  rootDir: string;
}

export interface Project {
  id: string;
  dir: string;
  dependencies: Set<string>;
  packageJson: object | null;
}

export interface WorkspacePackage {
  id: string;
  name: string;
  dir: string;
  packageJson: object;
}

export interface ProjectContext {
  rootDir: string;
  gitTopLevel: string | null;
  projects: Project[];
  packages: WorkspacePackage[];
  tsconfigs: TsconfigEntry[];
  projectFor(file: string): Project;
  packageFor(file: string): WorkspacePackage | null;
  optionsFor(file: string): { options: ts.CompilerOptions; entry: TsconfigEntry | null };
  isIgnored(path: string): boolean;
  unsupported: string[];
  warnings: string[];
}

export interface DiscoverOptions {
  fs?: FileSystemLike;
  localExclude?: string[];
}
