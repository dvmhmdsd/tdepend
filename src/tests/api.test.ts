import { describe, expect, it } from 'vitest';

import * as api from '../index';

describe('public API surface', () => {
  it('exposes only the documented runtime exports', () => {
    expect(Object.keys(api).sort()).toEqual([
      'analyze',
      'check',
      'explainFile',
      'exportToFile',
      'init',
      'toSerializable',
    ]);
  });

  it('tdepend/presets exposes definePreset and builtInPresets', async () => {
    const presets = await import('../presets');
    expect(Object.keys(presets).sort()).toEqual(['builtInPresets', 'definePreset']);
  });
});
