import { cartModel } from '@/features/cart/model';

export function format(): string {
  return cartModel().toUpperCase();
}
