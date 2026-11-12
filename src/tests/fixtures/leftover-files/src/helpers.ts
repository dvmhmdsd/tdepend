import { orderTotal } from './orders/orders.service';

export const formatTotal = (): string => `${orderTotal()}`;
