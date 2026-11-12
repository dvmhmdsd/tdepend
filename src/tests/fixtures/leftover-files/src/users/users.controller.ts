import { config } from '../config';
import { log } from '../logger';
import { findUser } from './users.service';

export const usersController = (): string => log(`${config.port} ${findUser()}`);
