export interface ParsedClass {
  name: string;
  isAbstract: boolean;
  isExported: boolean;
  filePath: string;
}

export interface ParsedNamespace {
  name: string;
  filePath: string;
}

export interface ParsedModule {
  /** Normalized absolute path to the module file */
  filePath: string;
  /** Resolved import paths (normalized file paths) */
  imports: string[];
  /** Names of exported symbols */
  exports: string[];
  /** Parsed classes in this module */
  classes: ParsedClass[];
  /** Parsed namespaces in this module */
  namespaces: ParsedNamespace[];
  /** Count of interfaces (for abstractness calculation) */
  interfaces: number;
  /** Total count of types (classes + interfaces) */
  totalTypes: number;
}
