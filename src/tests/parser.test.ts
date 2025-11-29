import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/loadConfig';
import { scanFiles } from '../parser/fileScanner';
import { parseFile, parseProject } from '../parser/tsParser';

const TEST_DIR = join(process.cwd(), '.test-parser-fixtures');

describe('File Scanner', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('scans files matching include patterns', async () => {
    // Create test files
    writeFileSync(join(TEST_DIR, 'file1.ts'), 'export const a = 1;');
    writeFileSync(join(TEST_DIR, 'file2.ts'), 'export const b = 2;');
    writeFileSync(join(TEST_DIR, 'file3.js'), 'export const c = 3;');

    const config = loadConfig();
    config.include = [`${TEST_DIR}/**/*.ts`];
    config.exclude = [];

    const files = await scanFiles(config);

    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes('file1.ts'))).toBe(true);
    expect(files.some((f) => f.includes('file2.ts'))).toBe(true);
    expect(files.some((f) => f.includes('file3.js'))).toBe(false);
  });

  it('excludes files matching exclude patterns', async () => {
    writeFileSync(join(TEST_DIR, 'source.ts'), 'export const x = 1;');
    writeFileSync(join(TEST_DIR, 'source.test.ts'), 'import { x } from "./source";');

    const config = loadConfig();
    config.include = [`${TEST_DIR}/**/*.ts`];
    config.exclude = ['**/*.test.ts'];

    const files = await scanFiles(config);

    expect(files.length).toBe(1);
    expect(files[0]).toContain('source.ts');
    expect(files[0]).not.toContain('source.test.ts');
  });
});

describe('TypeScript Parser', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('parses imports from a TypeScript file', () => {
    const filePath = join(TEST_DIR, 'imports.ts');
    writeFileSync(
      filePath,
      `
import { helper } from './helper';
import * as utils from './utils';
import type { User } from './types';
export const data = 1;
    `.trim(),
    );

    const parsed = parseFile(filePath);

    expect(parsed.filePath).toContain('imports.ts');
    expect(parsed.imports.length).toBe(3);
    expect(parsed.imports.some((i) => i.includes('helper.ts'))).toBe(true);
    expect(parsed.imports.some((i) => i.includes('utils.ts'))).toBe(true);
    expect(parsed.imports.some((i) => i.includes('types.ts'))).toBe(true);
  });

  it('parses exported classes', () => {
    const filePath = join(TEST_DIR, 'classes.ts');
    writeFileSync(
      filePath,
      `
export class UserService {}
export abstract class BaseService {}
class PrivateHelper {}
    `.trim(),
    );

    const parsed = parseFile(filePath);

    expect(parsed.classes.length).toBe(3);
    expect(parsed.classes.find((c) => c.name === 'UserService')?.isExported).toBe(true);
    expect(parsed.classes.find((c) => c.name === 'BaseService')?.isAbstract).toBe(true);
    expect(parsed.classes.find((c) => c.name === 'PrivateHelper')?.isExported).toBe(false);
    expect(parsed.exports).toContain('UserService');
    expect(parsed.exports).toContain('BaseService');
  });

  it('parses interfaces and counts them', () => {
    const filePath = join(TEST_DIR, 'interfaces.ts');
    writeFileSync(
      filePath,
      `
export interface User {
  name: string;
}
export interface Post {
  title: string;
}
interface PrivateConfig {}
    `.trim(),
    );

    const parsed = parseFile(filePath);

    expect(parsed.interfaces).toBe(3);
    expect(parsed.exports).toContain('User');
    expect(parsed.exports).toContain('Post');
    expect(parsed.totalTypes).toBe(3); // 0 classes + 3 interfaces
  });

  it('parses namespaces', () => {
    const filePath = join(TEST_DIR, 'namespaces.ts');
    writeFileSync(
      filePath,
      `
export namespace Utils {
  export function helper() {}
}
namespace Internal {
  export const x = 1;
}
    `.trim(),
    );

    const parsed = parseFile(filePath);

    expect(parsed.namespaces.length).toBe(2);
    expect(parsed.namespaces.find((n) => n.name === 'Utils')).toBeDefined();
    expect(parsed.namespaces.find((n) => n.name === 'Internal')).toBeDefined();
    expect(parsed.exports).toContain('Utils');
  });

  it('handles TSX files', () => {
    const filePath = join(TEST_DIR, 'component.tsx');
    writeFileSync(
      filePath,
      `
import React from 'react';
export function Component() {
  return <div>Hello</div>;
}
    `.trim(),
    );

    const parsed = parseFile(filePath);

    expect(parsed.filePath).toContain('component.tsx');
    expect(parsed.exports).toContain('Component');
  });

  it('parses multiple files in a project', () => {
    const file1 = join(TEST_DIR, 'module1.ts');
    const file2 = join(TEST_DIR, 'module2.ts');

    writeFileSync(file1, 'export class Service1 {}');
    writeFileSync(file2, 'export class Service2 {}');

    const modules = parseProject([file1, file2]);

    expect(modules.length).toBe(2);
    expect(modules[0].classes.length).toBe(1);
    expect(modules[1].classes.length).toBe(1);
  });
});
