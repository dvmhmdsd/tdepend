import { Svc } from './dep';

declare function Inject(...args: unknown[]): void;

@Inject
class Consumer {
  constructor(private readonly service: Svc) {}
}
