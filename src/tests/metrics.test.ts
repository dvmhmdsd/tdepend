import { describe, expect, it } from 'vitest';

import { computeAbstractness } from '../metrics/abstractness';
import { computeDistance } from '../metrics/distance';
import { computeInstability } from '../metrics/instability';
import type { ParsedModule } from '../types/parser';

function createModule(
  interfaces: number,
  concreteClasses: number,
  abstractClasses: number,
): ParsedModule {
  const classes = [
    ...Array.from({ length: concreteClasses }).map((_, i) => ({
      name: `Concrete${i}`,
      isAbstract: false,
      isExported: true,
      filePath: '/test.ts',
    })),
    ...Array.from({ length: abstractClasses }).map((_, i) => ({
      name: `Abstract${i}`,
      isAbstract: true,
      isExported: true,
      filePath: '/test.ts',
    })),
  ];

  return {
    filePath: '/test.ts',
    imports: [],
    exports: [],
    classes,
    namespaces: [],
    interfaces,
    totalTypes: interfaces + concreteClasses + abstractClasses,
  };
}

describe('Abstractness', () => {
  it('returns 0 for module with no types', () => {
    const module = createModule(0, 0, 0);
    expect(computeAbstractness(module)).toBe(0);
  });

  it('returns 1 for fully abstract module', () => {
    const module = createModule(2, 0, 1);
    expect(computeAbstractness(module)).toBe(1);
  });

  it('returns 0 for fully concrete module', () => {
    const module = createModule(0, 3, 0);
    expect(computeAbstractness(module)).toBe(0);
  });

  it('computes correct ratio for mixed module', () => {
    const module = createModule(2, 2, 0);
    expect(computeAbstractness(module)).toBe(0.5);
  });

  it('counts abstract classes as abstract types', () => {
    const module = createModule(1, 1, 2);
    expect(computeAbstractness(module)).toBe(0.75);
  });
});

describe('Instability', () => {
  it('returns 0 for isolated module', () => {
    expect(computeInstability(0, 0)).toBe(0);
  });

  it('returns 0 for maximally stable module', () => {
    expect(computeInstability(10, 0)).toBe(0);
  });

  it('returns 1 for maximally unstable module', () => {
    expect(computeInstability(0, 10)).toBe(1);
  });

  it('computes correct ratio', () => {
    expect(computeInstability(3, 1)).toBe(0.25);
    expect(computeInstability(1, 3)).toBe(0.75);
  });
});

describe('Distance', () => {
  it('returns 0 for ideal balance (A=1, I=0)', () => {
    expect(computeDistance(1, 0)).toBe(0);
  });

  it('returns 0 for ideal balance (A=0, I=1)', () => {
    expect(computeDistance(0, 1)).toBe(0);
  });

  it('returns maximum distance for worst case', () => {
    expect(computeDistance(0, 0)).toBe(1);
    expect(computeDistance(1, 1)).toBe(1);
  });

  it('computes correct distance for intermediate values', () => {
    expect(computeDistance(0.5, 0.5)).toBe(0);
    expect(computeDistance(0.3, 0.3)).toBeCloseTo(0.4);
    expect(computeDistance(0.8, 0.8)).toBeCloseTo(0.6);
  });

  it('uses absolute value', () => {
    expect(computeDistance(0.2, 0.3)).toBe(computeDistance(0.3, 0.2));
  });
});
