export enum Status {
  Active = 'active',
  Closed = 'closed',
}

export interface Handler {
  handle: (input: string) => void;
}

export type Callback = (value: string) => void;

export type Mode = 'read' | 'write';

export type Payload = { id: string; tags: string[] };

export class CreateItemDto {
  name = '';
  quantity = 0;
}

export class ItemView {
  label = '';
  render = (): string => this.label;
}

export class Priced {
  price = 0;
  get withTax(): number {
    return this.price * 1.2;
  }
}

export class ArchivedItemDto extends CreateItemDto {}

function partial<T>(base: T): T {
  return base;
}

export class UpdateItemDto extends partial(CreateItemDto) {}

export class ItemModule {}

export class ItemError extends Error {
  code = 'item';
}
