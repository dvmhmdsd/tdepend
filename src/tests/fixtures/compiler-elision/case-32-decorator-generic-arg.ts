import { Svc } from './dep';

declare function Get(): (target: object, key: string) => void;

class Controller {
  @Get()
  async list(): Promise<Svc[]> {
    return [];
  }
}

export { Controller };
