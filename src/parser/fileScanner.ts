import { glob } from 'glob';

import type { TDependConfig } from '../config/schema';
import { normalizePath } from '../utils/pathUtils';

/**
 * Scan files based on include/exclude patterns from config
 *
 * @param config - TDepend configuration with include/exclude patterns
 * @returns Array of normalized absolute file paths
 */
export async function scanFiles(config: TDependConfig): Promise<string[]> {
  const { include, exclude } = config;

  // Scan files matching include patterns
  const files = await glob(include, {
    ignore: exclude,
    absolute: true,
    nodir: true,
  });

  return files.map((file) => normalizePath(file));
}
