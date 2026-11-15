import type { Compiler } from '../parser/loadsTarget';
import type { SymbolIndex } from '../symbols/types';
import { fileGraphOf, type BuildGraphResult, type SiteRecord } from './buildFileGraph';

// The parser alone can't tell `export { T } from './x'` with T an interface
// from one with T a value, so such a site loads. tsc sees the types and erases
// it; esbuild and swc keep it. When tsc is the only compiler, the symbol index
// settles it: a site whose every name is only a type stops loading, and the
// graph is rebuilt so edge runtime flags and the graph id follow. Anything
// unresolved, merged with a value, or not provably a type keeps loading.
// Sites are updated in place.
export function eraseTypeReexports(
  built: BuildGraphResult,
  index: SymbolIndex,
  compilers: Compiler[],
): BuildGraphResult {
  if (compilers.length !== 1 || compilers[0] !== 'tsc') return built;

  let erased = 0;
  for (const record of built.sites) {
    const reason = erasureReason(record, index);
    if (reason === null) continue;
    record.site.loadsTarget = false;
    record.site.loadsTargetBy = 'symbols';
    record.site.loadReason = reason;
    erased += 1;
  }
  if (erased === 0) return built;
  return { ...built, graph: fileGraphOf(built.graph.files(), built.sites) };
}

function erasureReason(record: SiteRecord, index: SymbolIndex): string | null {
  const { site, resolution } = record;
  if (site.loadsTarget !== true || site.bindings.length === 0) return null;
  if (resolution.class !== 'internal' && resolution.class !== 'workspace') return null;
  const target = resolution.target;
  if (target === null || !('file' in target)) return null;

  const onlyTypes = site.bindings.every((binding) =>
    index.isTypeOnlyExport(target.file, binding.imported),
  );
  if (!onlyTypes) return null;
  if (site.kind === 're-export') {
    return 're-exports only types, and tsc is the only compiler, so tsc erases it';
  }
  if (site.kind === 'static' && site.valueUsesAreExports === true) {
    return 'imports only types that this file re-exports, and tsc is the only compiler, so tsc erases it';
  }
  return null;
}
