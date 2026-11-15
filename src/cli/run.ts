import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { Command, CommanderError, Option } from 'commander';

import { analyze } from '../api/analyze';
import { baselinePath, check, checkAnalysis } from '../api/check';
import { exportToFile } from '../api/export';
import { init } from '../api/init';
import { pruneBaseline, readBaseline, saveBaseline, writeBaseline } from '../baseline/baseline';
import { explainFile, type ExplainRow } from '../api/explain';
import { toSerializable } from '../api/serialization';
import { ConfigError, ParseError } from '../errors';
import { formatAnalyzeText } from '../output/analyzeText';
import { exitCodeFor } from '../output/exitCode';
import { formatJson, formatText } from '../output/formatCheck';
import type { Target } from '../resolver/types';
import { packageVersion } from '../version';

export interface CliIo {
  cwd: string;
  stdout(s: string): void;
  stderr(s: string): void;
}

type ExitCode = 0 | 1 | 2;

interface CommonOptions {
  root?: string;
  config?: string;
}

interface AnalyzeCliOptions extends CommonOptions {
  format?: string;
  export?: string;
  strictResolution?: boolean;
}

interface CheckCliOptions extends CommonOptions {
  baseline?: string;
  format?: 'text' | 'json';
  strictResolution?: boolean;
  pathPrefix?: string;
}

const DEFAULT_BASELINE = 'tdepend-baseline.json';

/**
 * Runs the CLI and resolves to its exit code.
 */
export async function runCli(argv: string[], io: CliIo): Promise<ExitCode> {
  let exitCode: ExitCode = 0;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    return handleError(error, io);
  }
}

function handleError(error: unknown, io: CliIo): ExitCode {
  if (error instanceof ConfigError || error instanceof ParseError) {
    writeLine(io.stderr, error.message);
    return 2;
  }
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? 0 : 2;
  }
  writeLine(io.stderr, error instanceof Error ? error.message : String(error));
  return 2;
}

function buildProgram(io: CliIo, setExitCode: (code: ExitCode) => void): Command {
  const program = new Command();

  program
    .name('tdepend')
    .description('Executable architecture contracts for TypeScript')
    .version(packageVersion())
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    });

  const rootFor = (options: CommonOptions): string =>
    options.root === undefined ? io.cwd : resolvePath(io.cwd, options.root);
  const configFor = (options: CommonOptions): string | undefined =>
    options.config === undefined ? undefined : resolvePath(io.cwd, options.config);

  program
    .command('analyze')
    .description('Analyze a TypeScript project and report its import graph')
    .option('-r, --root <dir>', 'analysis root, defaults to the working directory')
    .option('-c, --config <path>', 'path to the tdepend config file')
    .addOption(
      new Option('-f, --format <format>', 'output format')
        .choices(['text', 'json'])
        .default('text'),
    )
    .option('-e, --export <path>', 'write the full result to a JSON file')
    .option('--strict-resolution', 'exit 2 when any import is unresolved')
    .action(async (options: AnalyzeCliOptions) => {
      const result = await analyze({ root: rootFor(options), config: configFor(options) });

      if (options.export !== undefined) {
        await exportToFile(result, resolvePath(io.cwd, options.export));
      }
      if (options.format === 'json') {
        io.stdout(`${JSON.stringify(toSerializable(result), null, 2)}\n`);
      } else {
        io.stdout(formatAnalyzeText(result));
      }
      if (options.strictResolution === true && result.report.unresolved.length > 0) {
        setExitCode(2);
      }
    });

  program
    .command('explain')
    .description('Show every import in one file with its kind, load verdict and resolution')
    .argument('<file>', 'file to explain, relative to the analysis root')
    .option('-r, --root <dir>', 'analysis root, defaults to the working directory')
    .option('-c, --config <path>', 'path to the tdepend config file')
    .action(async (file: string, options: CommonOptions) => {
      const rows = await explainFile({ root: rootFor(options), config: configFor(options), file });
      io.stdout(formatExplain(rows));
    });

  program
    .command('check')
    .description('Evaluate the rules and exit 1 on any error the baseline does not cover')
    .option('-r, --root <dir>', 'analysis root, defaults to the working directory')
    .option('-c, --config <path>', 'path to the tdepend config file')
    .option('-b, --baseline <path>', 'baseline file to compare with, overriding the config')
    .addOption(
      new Option('-f, --format <format>', 'output format')
        .choices(['text', 'json'])
        .default('text'),
    )
    .option('--strict-resolution', 'exit 2 when any import is unresolved')
    .option('--path-prefix <prefix>', 'put before every path in the output', '')
    .action(async (options: CheckCliOptions) => {
      const report = await check({
        root: rootFor(options),
        config: configFor(options),
        baseline:
          options.baseline === undefined ? undefined : resolvePath(io.cwd, options.baseline),
      });
      io.stdout(
        options.format === 'json'
          ? formatJson(report)
          : formatText(report, { pathPrefix: options.pathPrefix ?? '' }),
      );
      setExitCode(exitCodeFor(report, { strictResolution: options.strictResolution === true }));
    });

  program
    .command('baseline')
    .description('Accept every current violation into the baseline, or prune it with --prune')
    .option('-r, --root <dir>', 'analysis root, defaults to the working directory')
    .option('-c, --config <path>', 'path to the tdepend config file')
    .option('--prune', 'only lower counts and drop entries; never accept anything new')
    .action(async (options: CommonOptions & { prune?: boolean }) => {
      const root = rootFor(options);
      const result = await analyze({ root, config: configFor(options) });
      const path =
        baselinePath({ root }, result) ?? resolvePath(result.configDir, DEFAULT_BASELINE);
      const { violations } = checkAnalysis(result, null);
      if (options.prune === true) {
        const before = readBaseline(path);
        const pruned = pruneBaseline(before, violations);
        saveBaseline(path, pruned);
        writeLine(io.stdout, `Pruned ${path}: ${before.size} → ${pruned.entries.length} entries.`);
        return;
      }
      const existed = existsSync(path);
      writeBaseline(path, violations);
      writeLine(
        io.stdout,
        `${existed ? 'Rewrote' : 'Wrote'} ${path} with ${violations.length} accepted violation${violations.length === 1 ? '' : 's'}.`,
      );
    });

  program
    .command('init')
    .description('Write a starter tdepend.config.json for the detected projects and presets')
    .option('-r, --root <dir>', 'folder to write the config in, defaults to the working directory')
    .option('--force', 'overwrite an existing config')
    .action(async (options: { root?: string; force?: boolean }) => {
      const result = await init({ root: rootFor(options), force: options.force === true });
      const lines = Object.entries(result.projects).map(
        ([projectId, presets]) => `  ${projectId}: ${presets.join(', ')}`,
      );
      io.stdout(`Detected presets:\n${lines.join('\n')}\nWrote ${result.written}\n`);
    });

  return program;
}

function formatExplain(rows: ExplainRow[]): string {
  if (rows.length === 0) return '';
  return `${rows.map(formatExplainRow).join('\n')}\n`;
}

function formatExplainRow(row: ExplainRow): string {
  const verdict = `${row.loadsTarget ? 'loads' : 'erased'} (${row.loadsTargetBy ?? '-'}): ${row.loadReason}`;
  const target = formatTarget(row.target);
  return `${row.line}:${row.column}  ${row.kind}  ${row.class}  '${row.specifier}' -> ${target}  ${verdict}`;
}

function formatTarget(target: Target | null): string {
  if (target === null) return '-';
  return 'file' in target ? target.file : target.module;
}

function writeLine(write: (s: string) => void, message: string): void {
  write(message.endsWith('\n') ? message : `${message}\n`);
}
