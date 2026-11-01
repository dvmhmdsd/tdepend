import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { explainFile } from '../api/explain';

const FIXTURES = join(process.cwd(), 'src', 'tests', 'fixtures');

describe('explainFile', () => {
  it('lists every import with its load verdict and resolution class', async () => {
    const rows = await explainFile({
      root: join(FIXTURES, 'vite-tanstack-router'),
      file: 'src/main.tsx',
    });

    expect(rows).toHaveLength(10);

    const missing = rows.find((row) => row.specifier === './missing');
    expect(missing).toMatchObject({ class: 'unresolved', loadsTarget: true, target: null });
    expect(missing?.loadReason.length).toBeGreaterThan(0);

    const builtin = rows.find((row) => row.specifier === 'node:fs');
    expect(builtin).toMatchObject({ class: 'builtin', target: { module: 'node:fs' } });

    const cart = rows.find((row) => row.specifier === './features/cart');
    expect(cart).toMatchObject({
      class: 'internal',
      target: { file: 'src/features/cart/index.ts' },
      kind: 'side-effect',
    });

    const asset = rows.find((row) => row.specifier === './styles.css');
    expect(asset).toMatchObject({ class: 'asset', target: null });
  });

  it('accepts an absolute path and returns nothing for a file with no imports', async () => {
    const root = join(FIXTURES, 'nest-cjs');

    const rows = await explainFile({ root, file: join(root, 'src', 'user.repository.ts') });

    expect(rows).toEqual([]);
  });
});
