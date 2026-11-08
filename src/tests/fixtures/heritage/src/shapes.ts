export interface Readable {
  read(): string;
}

export interface Stream extends Readable {
  close(): void;
}

export type Source = Readable;

export type Pair = { left: string; right: string };
