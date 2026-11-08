import { Repository } from './named-barrel';

export class OrderRepository implements Repository<number> {
  find(): number | undefined {
    return undefined;
  }
}
