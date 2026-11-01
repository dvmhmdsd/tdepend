import { describe, expect, it } from 'vitest';

import * as api from '../index';

describe('public API surface', () => {
  it('exposes only the documented runtime exports', () => {
    expect(Object.keys(api).sort()).toEqual([
      'analyze',
      'explainFile',
      'exportToFile',
      'toSerializable',
    ]);
  });
});
