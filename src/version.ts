import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read from the package manifest, one folder above both `src/` and `dist/`.
export function packageVersion(): string {
  const manifest = readFileSync(join(__dirname, '..', 'package.json'), 'utf-8');
  return (JSON.parse(manifest) as { version: string }).version;
}
