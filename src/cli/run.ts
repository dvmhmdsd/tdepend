import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { Command, CommanderError, Option } from 'commander';

import { analyze } from '../api/analyze';
import { exportToFile } from '../api/export';
import { explainFile, type ExplainRow } from '../api/explain';
import { toSerializable } from '../api/serialization';
import { ConfigError, ParseError } from '../errors';
import { formatAnalyzeText } from '../output/analyzeText';
import type { Target } from '../resolver/types';

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

/**
 * Runs the CLI and resolves to its exit code. Only the commands that exist at
 * this milestone are registered: `analyze` and `explain`.
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

function packageVersion(): string {
  const manifest = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8');
  return (JSON.parse(manifest) as { version: string }).version;
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
      new Option('-f, --format <format>', 'output format').choices(['text', 'json']).default('text'),
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
