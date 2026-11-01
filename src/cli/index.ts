#!/usr/bin/env node
import { runCli } from './run';

void runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (message) => {
    process.stdout.write(message);
  },
  stderr: (message) => {
    process.stderr.write(message);
  },
}).then((code) => {
  process.exitCode = code;
});
