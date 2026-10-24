import { Command, CommanderError } from 'commander';

import { ConfigError, ParseError } from '../errors';
import { loadConfig } from '../config/loadConfig';

export interface CliIo {
  cwd: string;
  stdout(s: string): void;
  stderr(s: string): void;
}

export async function runCli(argv: string[], io: CliIo): Promise<0 | 1 | 2> {
  const program = buildProgram(io);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
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
}

function buildProgram(io: CliIo): Command {
  const program = new Command();

  program
    .name('tdepend')
    .description('Executable architecture contracts for TypeScript')
    .exitOverride()
    .showHelpAfterError(true)
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    });

  program
    .command('analyze')
    .description('Analyze a TypeScript project')
    .option('-c, --config <path>', 'path to the tdepend config file')
    .action((options: { config?: string }) => {
      loadConfig({ cwd: io.cwd, configPath: options.config });
    });

  return program;
}

function writeLine(write: (s: string) => void, message: string): void {
  write(message.endsWith('\n') ? message : `${message}\n`);
}
