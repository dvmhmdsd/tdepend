import { UsersService } from './users.service';
import { UsersRepository } from './repositories/users.repository';

export class UsersController {
  service = new UsersService();
  repository = new UsersRepository();
}
