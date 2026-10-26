import { UserService } from './users/user.service.js';

export class UserController {
  constructor(private readonly users: UserService) {}
}
