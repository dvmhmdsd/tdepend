import { UsersRepository } from '../users/repositories/users.repository';
import { UsersService } from '@users/users.service';
import { fakeUser } from '../users/testing';

export class OrdersService {
  users = new UsersRepository();
  service = (): UsersService => new UsersService();
  sample = fakeUser;
}
