import { Svc } from './dep';

declare function Inject(): (target: object, key: string | undefined, index: number) => void;

class Consumer {
  constructor(@Inject() private readonly service: Svc) {}
}

export { Consumer };
