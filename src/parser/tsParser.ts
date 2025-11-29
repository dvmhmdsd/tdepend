import { dirname, resolve } from 'node:path';
import { Project, type SourceFile } from 'ts-morph';

import type { ParsedClass, ParsedModule, ParsedNamespace } from '../types/parser';
import { isExternalModule, isRelativeImport, normalizePath } from '../utils/pathUtils';

function extractImports(sourceFile: SourceFile, filePath: string): string[] {
  const imports: string[] = [];
  const importDeclarations = sourceFile.getImportDeclarations();

  for (const importDecl of importDeclarations) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();

    if (isRelativeImport(moduleSpecifier)) {
      const resolvedPath = resolveImportPath(moduleSpecifier, filePath);
      if (resolvedPath) {
        imports.push(resolvedPath);
      }
    } else if (!isExternalModule(moduleSpecifier)) {
      // Handle absolute imports (potential path aliases)
      // For now, we'll skip these - full path alias resolution needs tsconfig
      // This will be enhanced if needed
    }
  }

  return imports;
}

function extractClasses(sourceFile: SourceFile, filePath: string): {
  classes: ParsedClass[];
  exports: string[];
} {
  const classes: ParsedClass[] = [];
  const exports: string[] = [];
  const classDeclarations = sourceFile.getClasses();

  for (const classDecl of classDeclarations) {
    const name = classDecl.getName();
    if (name) {
      const isAbstract = classDecl.isAbstract();
      const isExported = classDecl.isExported();

      classes.push({
        name,
        isAbstract,
        isExported,
        filePath,
      });

      if (isExported) {
        exports.push(name);
      }
    }
  }

  return { classes, exports };
}

function extractInterfaces(sourceFile: SourceFile): {
  interfaces: number;
  exports: string[];
} {
  const exports: string[] = [];
  let interfaces = 0;
  const interfaceDeclarations = sourceFile.getInterfaces();

  for (const interfaceDecl of interfaceDeclarations) {
    const name = interfaceDecl.getName();
    if (interfaceDecl.isExported()) {
      exports.push(name);
      interfaces++;
    } else {
      interfaces++;
    }
  }

  return { interfaces, exports };
}

function extractNamespaces(sourceFile: SourceFile, filePath: string): {
  namespaces: ParsedNamespace[];
  exports: string[];
} {
  const namespaces: ParsedNamespace[] = [];
  const exports: string[] = [];
  const namespaceDeclarations = sourceFile.getModules();

  for (const namespaceDecl of namespaceDeclarations) {
    const name = namespaceDecl.getName();
    namespaces.push({
      name,
      filePath,
    });

    if (namespaceDecl.isExported()) {
      exports.push(name);
    }
  }

  return { namespaces, exports };
}

function extractOtherExports(sourceFile: SourceFile, existingExports: string[]): string[] {
  const otherExports: string[] = [];
  const exportedDeclarations = sourceFile.getExportedDeclarations();

  for (const [name, declarations] of exportedDeclarations) {
    if (existingExports.includes(name)) {
      continue;
    }

    if (declarations.length > 0) {
      otherExports.push(name);
    }
  }

  return otherExports;
}

function parseSourceFile(sourceFile: SourceFile): ParsedModule {
  const filePath = normalizePath(sourceFile.getFilePath());

  const imports = extractImports(sourceFile, filePath);
  const { classes, exports: classExports } = extractClasses(sourceFile, filePath);
  const { interfaces, exports: interfaceExports } = extractInterfaces(sourceFile);
  const { namespaces, exports: namespaceExports } = extractNamespaces(sourceFile, filePath);

  const allExports = [...classExports, ...interfaceExports, ...namespaceExports];
  const otherExports = extractOtherExports(sourceFile, allExports);
  const exports = [...allExports, ...otherExports];

  const totalTypes = classes.length + interfaces;

  return {
    filePath,
    imports,
    exports,
    classes,
    namespaces,
    interfaces,
    totalTypes,
  };
}

function resolveImportPath(importSpecifier: string, fromFile: string): string | null {
  const dir = dirname(fromFile);

  // Resolve relative to the importing file
  const resolvedPath = resolve(dir, importSpecifier);

  // Try .ts as default extension for TypeScript projects
  const pathWithTs = resolvedPath + '.ts';
  return normalizePath(pathWithTs);
}

/**
 * Parse multiple TypeScript files in a project
 *
 * @param filePaths - Array of file paths to parse
 * @param tsConfigPath - Optional path to tsconfig.json
 * @returns Array of ParsedModule objects
 */
export function parseProject(filePaths: string[], tsConfigPath?: string): ParsedModule[] {
  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: true,
  });

  // Add all files to the project
  for (const filePath of filePaths) {
    project.addSourceFileAtPath(filePath);
  }

  const modules: ParsedModule[] = [];
  const sourceFiles = project.getSourceFiles();

  for (const sourceFile of sourceFiles) {
    const parsedModule = parseSourceFile(sourceFile);
    modules.push(parsedModule);
  }

  return modules;
}

/**
 * Parse a single TypeScript file
 *
 * @param filePath - Path to the file to parse
 * @param project - Optional ts-morph Project instance
 * @returns ParsedModule with extracted information
 */
export function parseFile(filePath: string, project?: Project): ParsedModule {
  const proj = project || new Project();
  const sourceFile = proj.addSourceFileAtPath(filePath);
  return parseSourceFile(sourceFile);
}
