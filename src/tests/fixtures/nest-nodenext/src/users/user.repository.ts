import { PrismaClient } from '../generated/prisma/client.js';

export class UserRepository {
  private readonly prisma = new PrismaClient();

  find(): string[] {
    return [];
  }
}
