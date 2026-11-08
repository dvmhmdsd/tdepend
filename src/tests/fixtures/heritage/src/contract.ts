export interface Port {
  send(message: string): void;
}

export interface Shape {
  width: number;
}

export interface Clock {
  now(): number;
}
