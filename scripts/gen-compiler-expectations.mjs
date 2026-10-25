#!/usr/bin/env node
// Regenerates the checked-in compiler-elision expectations.
//
// Each case is a tiny source file that imports `./dep`. The script compiles it
// with every pinned compiler and records whether the emitted code still
// evaluates `./dep`. `loadsTarget` is the fixture's own expectation for
// tdepend: a case loads when any listed compiler keeps the import, or always
// when the case is marked `conservative` (tdepend deliberately retains it).
//
// Run: node scripts/gen-compiler-expectations.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import swc from '@swc/core';
import * as esbuild from 'esbuild';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'src', 'tests', 'fixtures', 'compiler-elision');
const DEP_FILE = join(FIXTURE_DIR, 'dep.ts');
const DEP_SPECIFIER = /['"]\.\/dep['"]/;

// `options` is the fixture's own JSON-friendly shape. `program: true` also
// emits with a full TypeScript program, where cross-file facts (const enum
// inlining, unmarked type re-exports) differ from a single-file transform.
// `conservative: true` marks a case tdepend keeps while a strict reading of
// the per-compiler verdicts would not.
const CASES = [
  { id: 'case-01', slug: 'import-type', ext: 'ts' },
  { id: 'case-02', slug: 'export-type', ext: 'ts' },
  { id: 'case-03', slug: 'type-context-import', ext: 'ts' },
  { id: 'case-04', slug: 'type-context-typeof', ext: 'ts' },
  { id: 'case-05', slug: 'inline-type', ext: 'ts' },
  {
    id: 'case-06',
    slug: 'inline-type-verbatim',
    ext: 'ts',
    options: { verbatimModuleSyntax: true },
  },
  { id: 'case-07', slug: 'empty-import', ext: 'ts' },
  {
    id: 'case-08',
    slug: 'empty-import-verbatim',
    ext: 'ts',
    options: { verbatimModuleSyntax: true },
  },
  { id: 'case-09', slug: 'empty-export', ext: 'ts' },
  {
    id: 'case-10',
    slug: 'empty-export-verbatim',
    ext: 'ts',
    options: { verbatimModuleSyntax: true },
  },
  { id: 'case-11', slug: 'empty-export-mjs', ext: 'mjs' },
  { id: 'case-12', slug: 'unmarked-reexport', ext: 'ts', program: true },
  { id: 'case-13', slug: 'reexport-star', ext: 'ts' },
  { id: 'case-14', slug: 'side-effect', ext: 'ts' },
  { id: 'case-15', slug: 'dynamic-import', ext: 'ts' },
  { id: 'case-16', slug: 'unused-import', ext: 'ts' },
  { id: 'case-17', slug: 'used-value', ext: 'ts' },
  { id: 'case-18', slug: 'type-only-usage', ext: 'ts' },
  { id: 'case-19', slug: 'mixed-usage', ext: 'ts' },
  { id: 'case-20', slug: 'shadowed-name', ext: 'ts', conservative: true },
  { id: 'case-21', slug: 'const-enum', ext: 'ts', program: true, conservative: true },
  { id: 'case-22', slug: 'namespace-type', ext: 'ts' },
  { id: 'case-23', slug: 'namespace-value', ext: 'ts' },
  { id: 'case-24', slug: 'js-static', ext: 'js' },
  {
    id: 'case-25',
    slug: 'preserve-value-imports',
    ext: 'ts',
    options: { preserveValueImports: true },
  },
  { id: 'case-26', slug: 'verbatim-static', ext: 'ts', options: { verbatimModuleSyntax: true } },
  { id: 'case-27', slug: 'classic-jsx', ext: 'tsx', options: { jsx: 'react' } },
  {
    id: 'case-28',
    slug: 'decorator-metadata',
    ext: 'ts',
    options: { experimentalDecorators: true, emitDecoratorMetadata: true },
  },
  {
    id: 'case-29',
    slug: 'no-decorator-metadata',
    ext: 'ts',
    options: { experimentalDecorators: true },
  },
  { id: 'case-30', slug: 'resolution-mode', ext: 'mts', options: { module: 'nodenext' } },
];

function fileNameOf(entry) {
  return `${entry.id}-${entry.slug}.${entry.ext}`;
}

function isJsFamily(file) {
  return /\.(js|mjs|cjs|jsx)$/i.test(file);
}

function stillLoads(output) {
  return DEP_SPECIFIER.test(output);
}

function toTsOptions(options = {}) {
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (options.module === 'nodenext') {
    compilerOptions.module = ts.ModuleKind.NodeNext;
    compilerOptions.moduleResolution = ts.ModuleResolutionKind.NodeNext;
  }
  if (options.verbatimModuleSyntax) compilerOptions.verbatimModuleSyntax = true;
  if (options.preserveValueImports) compilerOptions.preserveValueImports = true;
  if (options.importsNotUsedAsValues)
    compilerOptions.importsNotUsedAsValues = options.importsNotUsedAsValues;
  if (options.experimentalDecorators) compilerOptions.experimentalDecorators = true;
  if (options.emitDecoratorMetadata) compilerOptions.emitDecoratorMetadata = true;
  if (options.jsx === 'react') compilerOptions.jsx = ts.JsxEmit.React;
  return compilerOptions;
}

function transpileWithTsc(file, source, options) {
  const result = ts.transpileModule(source, {
    compilerOptions: toTsOptions(options),
    fileName: file,
  });
  return stillLoads(result.outputText);
}

function emitWithTscProgram(file, path, options) {
  const program = ts.createProgram([path, DEP_FILE], {
    ...toTsOptions(options),
    allowJs: true,
    noEmitOnError: false,
  });
  const sourceFile = program.getSourceFile(path);
  if (sourceFile === undefined) throw new Error(`program did not load ${file}`);
  let output = '';
  program.emit(sourceFile, (outputName, text) => {
    if (/\.(js|mjs|cjs|jsx)$/i.test(outputName)) output += text;
  });
  return stillLoads(output);
}

function loaderFor(file) {
  if (/\.tsx$/i.test(file)) return 'tsx';
  if (/\.jsx$/i.test(file)) return 'jsx';
  if (/\.(ts|mts|cts)$/i.test(file)) return 'ts';
  return 'js';
}

function transformWithEsbuild(file, source, options) {
  const result = esbuild.transformSync(source, {
    loader: loaderFor(file),
    format: 'esm',
    target: 'esnext',
    jsx: options.jsx === 'react' ? 'transform' : undefined,
    tsconfigRaw: {
      compilerOptions: {
        verbatimModuleSyntax: options.verbatimModuleSyntax,
        preserveValueImports: options.preserveValueImports,
        experimentalDecorators: options.experimentalDecorators,
        emitDecoratorMetadata: options.emitDecoratorMetadata,
      },
    },
  });
  return stillLoads(result.code);
}

function swcParser(file) {
  if (isJsFamily(file)) return { syntax: 'ecmascript', jsx: /\.jsx$/i.test(file) };
  return { syntax: 'typescript', tsx: /\.tsx$/i.test(file), decorators: true };
}

function transformWithSwc(file, source, options) {
  const transform = {
    verbatimModuleSyntax: options.verbatimModuleSyntax,
    legacyDecorator: options.experimentalDecorators,
    decoratorMetadata: options.emitDecoratorMetadata,
  };
  if (options.jsx === 'react') transform.react = { runtime: 'classic' };
  const result = swc.transformSync(source, {
    jsc: { parser: swcParser(file), target: 'esnext', transform },
  });
  return stillLoads(result.code);
}

function generate() {
  const written = [];
  for (const entry of CASES) {
    const file = fileNameOf(entry);
    const path = join(FIXTURE_DIR, file);
    const source = readFileSync(path, 'utf-8');
    const options = entry.options ?? {};

    const tsc = transpileWithTsc(file, source, options);
    const esbuildKeeps = transformWithEsbuild(file, source, options);
    const swcKeeps = transformWithSwc(file, source, options);
    const conservative = entry.conservative === true;
    const anyKeep = tsc || esbuildKeeps || swcKeeps;

    const expected = {
      id: entry.id,
      slug: entry.slug,
      file,
      options,
      tsc,
      esbuild: esbuildKeeps,
      swc: swcKeeps,
      conservative,
      loadsTarget: conservative || anyKeep,
    };
    if (entry.program === true) expected.tscProgram = emitWithTscProgram(file, path, options);

    const outPath = join(FIXTURE_DIR, `${entry.id}-${entry.slug}.expected.json`);
    writeFileSync(outPath, `${JSON.stringify(expected, null, 2)}\n`);
    written.push(expected);
  }

  console.log(`wrote ${written.length} expectations in ${FIXTURE_DIR}`);
  for (const expected of written) {
    const flags = `${expected.tsc ? 't' : '-'}${expected.esbuild ? 'e' : '-'}${expected.swc ? 's' : '-'}`;
    const program =
      expected.tscProgram === undefined ? '' : ` program:${expected.tscProgram ? 't' : '-'}`;
    const conservative = expected.conservative ? ' conservative' : '';
    console.log(
      `  ${expected.id} ${expected.slug.padEnd(24)} ${flags}${program}${conservative} -> ${expected.loadsTarget}`,
    );
  }
}

generate();
