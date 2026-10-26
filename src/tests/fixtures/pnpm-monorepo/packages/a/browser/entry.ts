import { browserOnly } from '@demo/cond/browser';
import { nodeOnly } from '@demo/cond/node-default-null';

export const b = `${browserOnly}${nodeOnly}`;
