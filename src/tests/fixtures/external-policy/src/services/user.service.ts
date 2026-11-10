import { PrismaClient } from '@prisma/client';
import { Button } from '@acme/ui/internal';
import axios from 'axios';
import { readFileSync } from 'fs';
import { writeFileSync } from 'node:fs';
import { shared } from '@acme/shared';
import type { Row } from '../generated/rows';

export const client = new PrismaClient();
export const render = (): unknown => Button;
export const fetchUser = (row: Row) => axios.get(`/users/${row.id}`);
export const save = (): void => writeFileSync('copy', readFileSync('source'));
export const label = shared;
