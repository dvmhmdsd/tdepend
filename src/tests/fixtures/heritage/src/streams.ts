import type { Source, Stream } from './shapes';

export class FileStream implements Stream {
  read(): string {
    return '';
  }
  close(): void {}
}

export class AliasSource implements Source {
  read(): string {
    return '';
  }
}

class Hidden implements Stream {
  read(): string {
    return '';
  }
  close(): void {}
}

export const streams = [new Hidden()];
