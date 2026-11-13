import { UsersModule } from './users/users.module';

export class AppModule {
  static imports = [UsersModule];
}
