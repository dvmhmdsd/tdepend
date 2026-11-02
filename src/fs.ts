import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

export type StatLike = { isFile(): boolean; isDirectory(): boolean };

export interface FileSystemLike {
  readFile(path: string): string;
  readdir(path: string): string[];
  stat(path: string): StatLike;
  realpath(path: string): string;
}

export function nodeFileSystem(): FileSystemLike {
  return {
    readFile: (path) => stripBom(readFileSync(path, 'utf-8')),
    readdir: (path) => readdirSync(path),
    stat: (path) => {
      const stats = statSync(path);
      return { isFile: () => stats.isFile(), isDirectory: () => stats.isDirectory() };
    },
    realpath: (path) => realpathSync.native(path),
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function tryRead(fs: FileSystemLike, path: string): string | null {
  try {
    return fs.readFile(path);
  } catch {
    return null;
  }
}

export function tryStat(fs: FileSystemLike, path: string): StatLike | null {
  try {
    return fs.stat(path);
  } catch {
    return null;
  }
}

export function isDir(fs: FileSystemLike, path: string): boolean {
  return tryStat(fs, path)?.isDirectory() ?? false;
}

export function isFile(fs: FileSystemLike, path: string): boolean {
  return tryStat(fs, path)?.isFile() ?? false;
}
