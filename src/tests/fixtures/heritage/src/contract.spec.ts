import type { Clock } from './contract';

export class FakeClock implements Clock {
  now(): number {
    return 0;
  }
}
