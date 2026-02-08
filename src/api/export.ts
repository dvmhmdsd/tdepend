import { writeFile } from 'fs/promises';
import { toSerializable } from './serialization';
import type { AnalysisResult } from '../types/api';

/**
 * Options for exporting analysis results.
 */
export interface ExportOptions {
  /**
   * Whether to pretty-print the JSON output.
   * @default true
   */
  pretty?: boolean;
}

/**
 * Exports analysis results to a JSON file.
 *
 * This function converts the analysis result to a serializable format
 * (fixing Set serialization issues) and writes it to the specified file.
 *
 * @param result - The analysis result to export
 * @param filePath - Path where the JSON file should be written
 * @param options - Export options (pretty-printing, etc.)
 *
 * @example
 * ```typescript
 * import { analyze, exportToFile } from 'tdepend';
 *
 * const result = await analyze({ rootDir: 'src' });
 * await exportToFile(result, 'architecture-snapshot.json');
 * ```
 */
export async function exportToFile(
  result: AnalysisResult,
  filePath: string,
  options: ExportOptions = {},
): Promise<void> {
  const json = exportToJson(result, options);
  await writeFile(filePath, json, 'utf-8');
}

/**
 * Converts analysis results to a JSON string.
 *
 * This function converts the analysis result to a serializable format
 * and returns it as a JSON string (does not write to file).
 *
 * @param result - The analysis result to export
 * @param options - Export options (pretty-printing, etc.)
 * @returns JSON string representation of the analysis result
 *
 * @example
 * ```typescript
 * import { analyze, exportToJson } from 'tdepend';
 *
 * const result = await analyze({ rootDir: 'src' });
 * const json = exportToJson(result, { pretty: false }); // Compact JSON
 * console.log(json);
 * ```
 */
export function exportToJson(result: AnalysisResult, options: ExportOptions = {}): string {
  const serialized = toSerializable(result);
  const indent = options.pretty !== false ? 2 : 0;
  return JSON.stringify(serialized, null, indent);
}
