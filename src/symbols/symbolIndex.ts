import { compareKeys, indexBy } from '../collections';
import type { SiteRecord } from '../graph/buildFileGraph';
import type { FileGraph } from '../graph/fileGraph';
import type { ImportSite, ParsedFile } from '../parser/types';
import type { Resolution } from '../resolver/types';
import {
  collectFileSymbols,
  exportedNames,
  type FileSymbols,
  type HeritageEntry,
} from './fileSymbols';
import type { Declaration, ExportInfo, HeritageRef, SymbolIndex, UnresolvedReason } from './types';

export type {
  DeclKind,
  Declaration,
  ExportInfo,
  HeritageClause,
  HeritageRef,
  SymbolIndex,
  UnresolvedReason,
} from './types';

type Entity =
  | { type: 'declaration'; declaration: Declaration }
  | { type: 'namespace'; file: string }
  | { type: 'unresolved'; reason: UnresolvedReason };

type SiteTarget = { file: string } | { unresolved: 'external' | 'missing' };

interface FileTable {
  file: string;
  symbols: FileSymbols;
  declarations: Map<string, Declaration>;
}

const unresolved = (reason: UnresolvedReason): Entity => ({ type: 'unresolved', reason });

// A syntactic index of what each file declares and exports, with heritage
// clauses resolved through imports and re-export chains. No type checker: a
// name is followed only through explicit bindings, and whatever cannot be
// followed is counted as unresolved, never guessed. Imports are followed with
// the resolutions the file graph already made, so both always agree.
export function buildSymbolIndex(
  graph: FileGraph,
  parsed: Map<string, ParsedFile>,
  sites: SiteRecord[],
): SymbolIndex {
  const tables = buildTables(graph.files(), parsed);
  const resolutions = new Map(sites.map((record) => [record.site, record.resolution]));
  const bindings = new BindingResolver(tables, resolutions);
  const heritage = resolveHeritage(tables, bindings);
  resolveDataShapes(tables, heritage);
  const exportCache = new Map<string, ExportInfo[]>();

  return {
    declarations: (file) => sortedDeclarations(tables.get(file)),
    exports: (file) => {
      let infos = exportCache.get(file);
      if (infos === undefined) {
        infos = bindings.exportsOf(file);
        exportCache.set(file, infos);
      }
      return [...infos];
    },
    heritage: () => [...heritage],
    resolveExport: (file, name) => declarationOf(bindings.resolveExport(file, name)),
    isTypeOnlyExport: (file, name) => {
      const declaration = declarationOf(bindings.resolveExport(file, name));
      if (declaration === null) return false;
      const symbols = tables.get(declaration.file)?.symbols;
      const local = symbols?.declarations.get(declaration.name);
      return local?.typeOnly === true && !symbols!.namespaces.has(declaration.name);
    },
    unresolvedHeritageCount: heritage.filter((ref) => ref.resolved === null).length,
  };
}

function buildTables(files: string[], parsed: Map<string, ParsedFile>): Map<string, FileTable> {
  const tables = new Map<string, FileTable>();
  for (const file of files) {
    const parsedFile = parsed.get(file);
    if (parsedFile === undefined) continue;
    const symbols = collectFileSymbols(parsedFile);
    const exported = exportedNames(symbols);
    const declarations = new Map<string, Declaration>();
    for (const local of symbols.declarations.values()) {
      declarations.set(local.name, {
        id: `${file}#${local.name}`,
        file,
        name: local.name,
        kind: local.kind,
        exported: exported.has(local.name) || local.kind === 'cjs-export',
        dataShape: false,
      });
    }
    tables.set(file, { file, symbols, declarations });
  }
  return tables;
}

function sortedDeclarations(table: FileTable | undefined): Declaration[] {
  if (table === undefined) return [];
  return [...table.declarations.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

function declarationOf(entity: Entity): Declaration | null {
  return entity.type === 'declaration' ? entity.declaration : null;
}

function resolveHeritage(tables: Map<string, FileTable>, bindings: BindingResolver): HeritageRef[] {
  const refs: HeritageRef[] = [];
  for (const table of tables.values()) {
    for (const entry of table.symbols.heritage) {
      refs.push(heritageRef(table, entry, bindings));
    }
  }
  return refs.sort(compareHeritage);
}

function heritageRef(
  table: FileTable,
  entry: HeritageEntry,
  bindings: BindingResolver,
): HeritageRef {
  const from = table.declarations.get(entry.from)!;
  const entity =
    entry.path === null
      ? unresolved('computed')
      : bindings.followAliases(bindings.resolvePath(table, entry.path));
  const ref: HeritageRef = {
    from,
    owner: entry.owner,
    clause: entry.clause,
    name: entry.name,
    resolved: null,
  };
  if (entity.type === 'declaration') ref.resolved = entity.declaration;
  else ref.unresolvedReason = entity.type === 'namespace' ? 'missing' : entity.reason;
  return ref;
}

// A declaration is data when its own syntax is and every base it extends is
// data too: `class NotFound extends HttpException {}` is not, because its base
// is external and may hold behaviour. A base that cannot be resolved, or a
// cycle of bases, is not data.
function resolveDataShapes(tables: Map<string, FileTable>, heritage: HeritageRef[]): void {
  const basesOf = indexBy(
    heritage.filter((ref) => ref.clause === 'extends'),
    (ref) => ref.from.id,
  );
  const verdicts = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isData = (declaration: Declaration): boolean => {
    const known = verdicts.get(declaration.id);
    if (known !== undefined) return known;
    if (visiting.has(declaration.id)) return false;
    visiting.add(declaration.id);
    const local = tables.get(declaration.file)!.symbols.declarations.get(declaration.name)!;
    const verdict =
      local.dataShape &&
      (basesOf.get(declaration.id) ?? []).every(
        (ref) => ref.resolved !== null && isData(ref.resolved),
      );
    visiting.delete(declaration.id);
    verdicts.set(declaration.id, verdict);
    return verdict;
  };

  for (const table of tables.values()) {
    for (const declaration of table.declarations.values()) {
      declaration.dataShape = isData(declaration);
    }
  }
}

function compareHeritage(a: HeritageRef, b: HeritageRef): number {
  return compareKeys([a.from.id, a.name, a.clause], [b.from.id, b.name, b.clause]);
}

// Resolves names to declarations across files. Export lookups are memoised; a
// lookup that runs into a cycle of barrels returns `missing` for that branch and
// is not memoised, so every top-level query sees the same answer.
class BindingResolver {
  private readonly targets = new Map<ImportSite, SiteTarget>();
  private readonly memo = new Map<string, Entity>();
  private readonly active = new Set<string>();
  private cuts = 0;

  constructor(
    private readonly tables: Map<string, FileTable>,
    private readonly resolutions: Map<ImportSite, Resolution>,
  ) {}

  resolveExport(file: string, name: string): Entity {
    const key = `${file}\0${name}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    if (this.active.has(key)) {
      this.cuts++;
      return unresolved('missing');
    }
    const table = this.tables.get(file);
    if (table === undefined) return unresolved('missing');

    this.active.add(key);
    const cutsBefore = this.cuts;
    const entity = this.lookupExport(table, name);
    this.active.delete(key);
    if (this.cuts === cutsBefore) this.memo.set(key, entity);
    return entity;
  }

  // A dotted name as written in a heritage clause or a type alias: the head is a
  // local name, each further part an export of the namespace before it. A name
  // declared nowhere in the file is a global, which is external.
  resolvePath(table: FileTable, path: string[]): Entity {
    let entity = this.resolveLocal(table, path[0]) ?? unresolved('external');
    for (const part of path.slice(1)) {
      if (entity.type === 'namespace') entity = this.resolveExport(entity.file, part);
      else if (entity.type === 'declaration') return unresolved('computed');
      else return entity;
    }
    return entity;
  }

  // `type T = A` stands for A, so a class implementing T implements A.
  followAliases(entity: Entity): Entity {
    const seen = new Set<string>();
    let current = entity;
    while (current.type === 'declaration' && !seen.has(current.declaration.id)) {
      const declaration = current.declaration;
      const table = this.tables.get(declaration.file)!;
      const aliasOf = table.symbols.declarations.get(declaration.name)?.aliasOf;
      if (aliasOf === undefined) break;
      seen.add(declaration.id);
      current = this.resolvePath(table, aliasOf);
    }
    return current;
  }

  exportsOf(file: string): ExportInfo[] {
    const table = this.tables.get(file);
    if (table === undefined) return [];

    const infos: ExportInfo[] = [];
    for (const [name, source] of table.symbols.exports) {
      const info = this.exportInfo(this.resolveExport(file, name));
      infos.push(
        source.type === 'reexport'
          ? { name, ...info, reexportFrom: source.site.specifier }
          : { name, ...info },
      );
    }
    for (const [name, specifiers] of this.starProviders(table, new Set([file]))) {
      if (table.symbols.exports.has(name)) continue;
      const entity = this.resolveExport(file, name);
      if (entity.type === 'unresolved' && entity.reason === 'ambiguous') continue;
      infos.push({ name, ...this.exportInfo(entity), reexportFrom: specifiers[0] });
    }
    return infos.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private lookupExport(table: FileTable, name: string): Entity {
    const source = table.symbols.exports.get(name);
    if (source?.type === 'local') {
      return this.resolveLocal(table, source.name) ?? unresolved('missing');
    }
    if (source?.type === 'reexport') return this.resolveBinding(source.site, source.imported);
    if (name === 'default') return unresolved('missing');
    return this.lookupStar(table, name);
  }

  // `export *` provides a name only when exactly one source declares it.
  private lookupStar(table: FileTable, name: string): Entity {
    const found = new Map<string, Entity>();
    let ambiguous = false;
    let external = false;
    for (const site of table.symbols.stars) {
      const target = this.targetOf(site);
      if ('unresolved' in target) {
        external ||= target.unresolved === 'external';
        continue;
      }
      const entity = this.resolveExport(target.file, name);
      if (entity.type === 'declaration') found.set(entity.declaration.id, entity);
      else if (entity.type === 'namespace') found.set(`namespace:${entity.file}`, entity);
      else if (entity.reason === 'ambiguous') ambiguous = true;
      else external ||= entity.reason === 'external';
    }
    if (found.size > 1 || ambiguous) return unresolved('ambiguous');
    if (found.size === 1) return [...found.values()][0];
    return unresolved(external ? 'external' : 'missing');
  }

  private resolveLocal(table: FileTable, name: string): Entity | null {
    const declaration = table.declarations.get(name);
    if (declaration !== undefined) return { type: 'declaration', declaration };
    const binding = table.symbols.imports.get(name);
    if (binding === undefined) return null;
    return this.resolveBinding(binding.site, binding.imported);
  }

  private resolveBinding(site: ImportSite, imported: string): Entity {
    const target = this.targetOf(site);
    if ('unresolved' in target) return unresolved(target.unresolved);
    if (imported === '*') return { type: 'namespace', file: target.file };
    return this.resolveExport(target.file, imported);
  }

  // Only files in the index are followed. An excluded target (a spec file) or a
  // failed resolution is missing; a package outside the workspace is external.
  private targetOf(site: ImportSite): SiteTarget {
    let target = this.targets.get(site);
    if (target !== undefined) return target;

    const resolution = this.resolutions.get(site);
    const file =
      resolution?.target != null && 'file' in resolution.target ? resolution.target.file : null;
    const followable = resolution?.class === 'internal' || resolution?.class === 'workspace';
    if (followable && file !== null && this.tables.has(file)) target = { file };
    else if (resolution?.class === 'external' || resolution?.class === 'builtin') {
      target = { unresolved: 'external' };
    } else target = { unresolved: 'missing' };

    this.targets.set(site, target);
    return target;
  }

  // Every name reachable through `export *`, with the specifiers that provide it.
  private starProviders(table: FileTable, visiting: Set<string>): Map<string, string[]> {
    const providers = new Map<string, string[]>();
    for (const site of table.symbols.stars) {
      const target = this.targetOf(site);
      if ('unresolved' in target || visiting.has(target.file)) continue;
      for (const name of this.exportNames(target.file, visiting)) {
        if (name === 'default') continue;
        const list = providers.get(name);
        if (list === undefined) providers.set(name, [site.specifier]);
        else list.push(site.specifier);
      }
    }
    return providers;
  }

  private exportNames(file: string, visiting: Set<string>): Set<string> {
    const table = this.tables.get(file)!;
    visiting.add(file);
    const names = new Set([
      ...table.symbols.exports.keys(),
      ...this.starProviders(table, visiting).keys(),
    ]);
    visiting.delete(file);
    return names;
  }

  private exportInfo(entity: Entity): Omit<ExportInfo, 'name'> {
    const declaration = declarationOf(entity);
    return { declaration, isAsyncFunction: declaration !== null && this.isAsync(declaration) };
  }

  private isAsync(declaration: Declaration): boolean {
    const table = this.tables.get(declaration.file);
    return table?.symbols.declarations.get(declaration.name)?.isAsyncFunction === true;
  }
}
