import { isAbsolute, relative } from 'node:path';

import { toPosix } from '../fs';
import type { EdgeKind } from '../parser/types';
import type { ResolutionClass, Target } from '../resolver/types';
import { analyze, type AnalyzeOptions } from './analyze';

export interface ExplainRow {
  specifier: string;
  line: number;
  column: number;
  kind: EdgeKind;
  loadsTarget: boolean;
  loadReason: string;
  class: ResolutionClass;
  target: Target | null;
}

/**
 * Lists every import in one file with its syntactic kind, whether it loads its
 * target at runtime (and why), and how it resolved. This is the debugging view
 * for the graph and the runtime-load contract.
 */
export async function explainFile(
  options: AnalyzeOptions & { file: string },
): Promise<ExplainRow[]> {
  const result = await analyze(options);
  const file = toRootRelative(result.ctx.rootDir, options.file);

  return result.sites
    .filter((record) => record.file === file)
    .map((record) => ({
      specifier: record.site.specifier,
      line: record.site.line,
      column: record.site.column,
      kind: record.site.kind,
      loadsTarget: record.site.loadsTarget === true,
      loadReason: record.site.loadReason ?? '',
      class: record.resolution.class,
      target: record.resolution.target,
    }));
}

function toRootRelative(rootDir: string, file: string): string {
  if (isAbsolute(file)) return toPosix(relative(rootDir, file));
  return toPosix(file.replace(/^\.\//, ''));
}
