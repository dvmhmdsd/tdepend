import { normalize, resolve, isAbsolute } from 'node:path';

/**
 * Normalize a file path to an absolute, cross-platform path
 */
export function normalizePath(filePath: string): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath);
  return normalize(absolutePath);
}

/**
 * Check if an import specifier is a relative import
 */
export function isRelativeImport(importSpecifier: string): boolean {
  return importSpecifier.startsWith('./') || importSpecifier.startsWith('../');
}

/**
 * Check if an import specifier is an external module
 */
export function isExternalModule(importSpecifier: string): boolean {
  // External if it doesn't start with . or /
  return !importSpecifier.startsWith('.') && !importSpecifier.startsWith('/');
}
