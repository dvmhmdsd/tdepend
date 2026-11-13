import { now } from '../common/clock';
import { UsersRepository } from './users.repository';

export class UsersController {
  readonly createdAt = now();

  constructor(private readonly users: UsersRepository) {}
}
