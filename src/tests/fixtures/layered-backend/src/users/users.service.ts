import { UsersRepository } from './repositories/users.repository';
import { config } from '../config';
import { OrdersService } from '../orders/orders.service';

export class UsersService {
  repository = new UsersRepository();
  pageSize = config.pageSize;
  orders = (): OrdersService => new OrdersService();
}
