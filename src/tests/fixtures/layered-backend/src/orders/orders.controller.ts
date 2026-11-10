import { OrdersService } from './orders.service';
import { UsersRepository } from '@users/repositories/users.repository';

export class OrdersController {
  service = new OrdersService();
  users = new UsersRepository();
}
