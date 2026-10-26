import '@/components/button';
import './features/cart';
import './styles.css';
import Logo from './logo.svg?react';
import 'virtual:pwa-register';
import './missing';
import { routeTree } from './routeTree.gen';
import { x } from './x.spec';
import leftPad from 'left-pad';
import fs from 'node:fs';

export function main() {
  return [Logo, routeTree, x, leftPad, fs];
}
