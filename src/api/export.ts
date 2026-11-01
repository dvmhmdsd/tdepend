import { writeFile } from 'node:fs/promises';

import type { AnalysisResult } from '../types/api';
import { toSerializable } from './serialization';

/**
 * Writes the versioned JSON export of an analysis to a file. The output is
 * pretty-printed and ends with a newline; two runs on the same inputs write
 * byte-identical files.
 */
export async function exportToFile(result: AnalysisResult, path: string): Promise<void> {
  await writeFile(path, `${JSON.stringify(toSerializable(result), null, 2)}\n`, 'utf-8');
}
