import type { PrismaClient } from '@prisma/client';
import { Button } from '@acme/ui';

export const describe = (client: PrismaClient): string => `${String(client)} ${String(Button)}`;
