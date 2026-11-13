import { UserRepository } from './user.repository';

export class AdminController {
  constructor(private readonly repository: UserRepository) {}
}
