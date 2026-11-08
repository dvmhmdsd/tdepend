export abstract class Repository<T> {
  abstract find(id: string): T | undefined;
}
