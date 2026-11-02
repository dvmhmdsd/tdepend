import { Svc } from './dep';

declare function Body(): (target: object, key: string, index: number) => void;

class Controller {
  handle(@Body() body: Svc): void {
    void body;
  }
}

export { Controller };
