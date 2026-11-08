import type { Found, Nowhere } from './cycle-a';

export class Kept implements Found {
  id = '';
}

export class Lost implements Nowhere {}
