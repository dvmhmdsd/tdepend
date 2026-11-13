import type { Preset } from './definePreset';
import { express } from './express';
import { fastify } from './fastify';
import { nest } from './nest';
import { node } from './node';
import { react } from './react';

// `auto` tries these in this order.
export const builtInPresets: Record<string, Preset> = { node, nest, react, express, fastify };

// When several presets give one project a component strategy, the first of
// these wins. A preset loaded from a module outranks every built-in.
export const COMPONENT_PRECEDENCE = ['nest', 'react', 'express', 'fastify', 'node'];
