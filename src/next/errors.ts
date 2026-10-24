export class ConfigError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ParseError extends Error {
  readonly exitCode = 2 as const;
  readonly file: string;

  constructor(message: string, file: string) {
    super(message);
    this.name = 'ParseError';
    this.file = file;
  }
}
