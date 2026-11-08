import { Repo } from './named-barrel';

export class UserRepository extends Repo<string> {
  find(): string | undefined {
    return undefined;
  }
}
