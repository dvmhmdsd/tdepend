import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../../next/cli/run';

let dir: string;
let stdout: string;
let stderr: string;

function io(): { cwd: string; stdout(s: string): void; stderr(s: string): void } {
  return {
    cwd: dir,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdepend-cli-'));
  stdout = '';
  stderr = '';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runCli', () => {
  it('unknown command returns 2 and prints usage to stderr', async () => {
    const code = await runCli(['bogus'], io());

    expect(code).toBe(2);
    expect(stderr.toLowerCase()).toContain('usage');
  });

  it('a ConfigError returns 2 with the message on stderr', async () => {
    writeFileSync(join(dir, 'tdepend.config.json'), JSON.stringify({ foo: 1 }));

    const code = await runCli(['analyze'], io());

    expect(code).toBe(2);
    expect(stderr).toContain('foo');
  });
});
