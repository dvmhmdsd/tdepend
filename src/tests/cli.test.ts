import { execa } from 'execa';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Basic smoke test to ensure CLI prints help
describe('CLI', () => {
  it('prints help for analyze', async () => {
    const builtCli = join(process.cwd(), 'dist', 'cli', 'index.js');
    const result = await execa('node', [builtCli, 'analyze', '--help']);
    expect(result.stdout).toMatch(/Analyze a TypeScript project/);
  });
});
