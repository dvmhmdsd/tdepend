import * as ts from 'typescript';

import type { ImportSite, ParsedFile } from '../parser/types';
import type { DeclKind, HeritageClause } from './types';

export interface LocalDeclaration {
  name: string;
  kind: DeclKind;
  isAsyncFunction: boolean;
  // `type T = X` or `type T = ns.X`: the name the alias stands for, split on dots.
  aliasOf?: string[];
}

// A local name bound by an import declaration. `imported` is the exported name,
// `default`, or `*` for a namespace import.
export interface ImportBinding {
  site: ImportSite;
  imported: string;
}

export type ExportSource =
  { type: 'local'; name: string } | { type: 'reexport'; site: ImportSite; imported: string };

export interface HeritageEntry {
  from: string;
  clause: HeritageClause;
  name: string;
  // The dotted name the clause references, or null for anything else (a call).
  path: string[] | null;
}

// What one file says about its own names, before anything is resolved.
export interface FileSymbols {
  declarations: Map<string, LocalDeclaration>;
  imports: Map<string, ImportBinding>;
  exports: Map<string, ExportSource>;
  stars: ImportSite[];
  heritage: HeritageEntry[];
}

// When one name has several declarations (merging, or a type and a value with
// the same name), the identity takes the kind that can be abstract, so merging
// is "abstract only through the interface rule".
const KIND_PRECEDENCE: DeclKind[] = [
  'interface',
  'abstract-class',
  'class',
  'type',
  'enum',
  'function',
  'variable',
  'cjs-export',
  'default-expression',
];

export function collectFileSymbols(parsed: ParsedFile): FileSymbols {
  const symbols: FileSymbols = {
    declarations: new Map(),
    imports: new Map(),
    exports: new Map(),
    stars: [],
    heritage: [],
  };
  const siteAt = new Map<ts.Node, ImportSite>(parsed.sites.map((site) => [site.node, site]));
  const visitor = new StatementVisitor(parsed.sourceFile, symbols, siteAt);
  for (const statement of parsed.sourceFile.statements) visitor.visit(statement);
  return symbols;
}

export function exportedNames(symbols: FileSymbols): Set<string> {
  const names = new Set<string>();
  for (const source of symbols.exports.values()) {
    if (source.type === 'local' && symbols.declarations.has(source.name)) names.add(source.name);
  }
  return names;
}

class StatementVisitor {
  constructor(
    private readonly sourceFile: ts.SourceFile,
    private readonly symbols: FileSymbols,
    private readonly siteAt: Map<ts.Node, ImportSite>,
  ) {}

  visit(statement: ts.Statement): void {
    if (ts.isImportDeclaration(statement)) this.importDeclaration(statement);
    else if (ts.isExportDeclaration(statement)) this.exportDeclaration(statement);
    else if (ts.isExportAssignment(statement)) this.exportAssignment(statement);
    else if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      this.heritageOwner(statement);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      this.declare(statement, statement.name.text, 'type', {
        aliasOf: typeReferencePath(statement.type),
      });
    } else if (ts.isEnumDeclaration(statement))
      this.declare(statement, statement.name.text, 'enum');
    else if (ts.isFunctionDeclaration(statement)) {
      const isAsyncFunction = hasModifier(statement, ts.SyntaxKind.AsyncKeyword);
      this.declare(statement, statement.name?.text ?? 'default', 'function', { isAsyncFunction });
    } else if (ts.isVariableStatement(statement)) this.variableStatement(statement);
    else if (ts.isExpressionStatement(statement)) this.commonJsExports(statement);
  }

  private importDeclaration(decl: ts.ImportDeclaration): void {
    const site = this.siteAt.get(decl.moduleSpecifier);
    const clause = decl.importClause;
    if (site === undefined || clause === undefined) return;

    if (clause.name !== undefined) this.bindImport(clause.name.text, site, 'default');
    const named = clause.namedBindings;
    if (named === undefined) return;
    if (ts.isNamespaceImport(named)) {
      this.bindImport(named.name.text, site, '*');
      return;
    }
    for (const element of named.elements) {
      this.bindImport(element.name.text, site, (element.propertyName ?? element.name).text);
    }
  }

  private exportDeclaration(decl: ts.ExportDeclaration): void {
    const clause = decl.exportClause;
    if (decl.moduleSpecifier === undefined) {
      if (clause === undefined || !ts.isNamedExports(clause)) return;
      for (const element of clause.elements) {
        this.symbols.exports.set(element.name.text, {
          type: 'local',
          name: (element.propertyName ?? element.name).text,
        });
      }
      return;
    }

    const site = this.siteAt.get(decl.moduleSpecifier);
    if (site === undefined) return;
    if (clause === undefined) {
      this.symbols.stars.push(site);
    } else if (ts.isNamespaceExport(clause)) {
      this.symbols.exports.set(clause.name.text, { type: 'reexport', site, imported: '*' });
    } else {
      for (const element of clause.elements) {
        const imported = (element.propertyName ?? element.name).text;
        this.symbols.exports.set(element.name.text, { type: 'reexport', site, imported });
      }
    }
  }

  // `export default name` names an existing binding; any other expression is a
  // declaration of its own.
  private exportAssignment(statement: ts.ExportAssignment): void {
    if (ts.isIdentifier(statement.expression)) {
      this.symbols.exports.set('default', { type: 'local', name: statement.expression.text });
      return;
    }
    this.addDeclaration('default', 'default-expression');
    this.symbols.exports.set('default', { type: 'local', name: 'default' });
  }

  private heritageOwner(node: ts.ClassDeclaration | ts.InterfaceDeclaration): void {
    const name = node.name?.text ?? 'default';
    const kind: DeclKind = ts.isInterfaceDeclaration(node)
      ? 'interface'
      : hasModifier(node, ts.SyntaxKind.AbstractKeyword)
        ? 'abstract-class'
        : 'class';
    this.declare(node, name, kind);
    this.collectHeritage(name, node.heritageClauses);
  }

  private variableStatement(statement: ts.VariableStatement): void {
    for (const declarator of statement.declarationList.declarations) {
      for (const name of bindingNames(declarator.name)) {
        const initializer = declarator.initializer;
        const isAsyncFunction =
          initializer !== undefined &&
          ts.isArrowFunction(initializer) &&
          hasModifier(initializer, ts.SyntaxKind.AsyncKeyword);
        this.declare(statement, name, 'variable', { isAsyncFunction });
        if (initializer !== undefined && ts.isClassExpression(initializer)) {
          this.collectHeritage(name, initializer.heritageClauses);
        }
      }
    }
  }

  private commonJsExports(statement: ts.ExpressionStatement): void {
    for (const name of commonJsNames(statement.expression)) {
      this.addDeclaration(name, 'cjs-export');
      this.symbols.exports.set(name, { type: 'local', name });
    }
  }

  private collectHeritage(
    from: string,
    clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  ): void {
    for (const clause of clauses ?? []) {
      const kind: HeritageClause =
        clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
      for (const type of clause.types) {
        this.symbols.heritage.push({
          from,
          clause: kind,
          name: type.expression.getText(this.sourceFile),
          path: expressionPath(type.expression),
        });
      }
    }
  }

  private declare(
    node: ts.Node,
    name: string,
    kind: DeclKind,
    extra: { isAsyncFunction?: boolean; aliasOf?: string[] } = {},
  ): void {
    this.addDeclaration(name, kind, extra);
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return;
    const exportedAs = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default' : name;
    this.symbols.exports.set(exportedAs, { type: 'local', name });
  }

  private addDeclaration(
    name: string,
    kind: DeclKind,
    extra: { isAsyncFunction?: boolean; aliasOf?: string[] } = {},
  ): void {
    const existing = this.symbols.declarations.get(name);
    if (existing === undefined) {
      this.symbols.declarations.set(name, {
        name,
        kind,
        isAsyncFunction: extra.isAsyncFunction === true,
        ...(extra.aliasOf === undefined ? {} : { aliasOf: extra.aliasOf }),
      });
      return;
    }
    if (KIND_PRECEDENCE.indexOf(kind) < KIND_PRECEDENCE.indexOf(existing.kind))
      existing.kind = kind;
    existing.isAsyncFunction ||= extra.isAsyncFunction === true;
    // A merged name is no longer a plain alias of one other name.
    delete existing.aliasOf;
  }

  private bindImport(local: string, site: ImportSite, imported: string): void {
    this.symbols.imports.set(local, { site, imported });
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function typeReferencePath(type: ts.TypeNode): string[] | undefined {
  return ts.isTypeReferenceNode(type) ? entityNamePath(type.typeName) : undefined;
}

function entityNamePath(name: ts.EntityName): string[] {
  return ts.isIdentifier(name) ? [name.text] : [...entityNamePath(name.left), name.right.text];
}

function expressionPath(expression: ts.Expression): string[] | null {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    const head = expressionPath(expression.expression);
    return head === null ? null : [...head, expression.name.text];
  }
  return null;
}

// `exports.x = …`, `module.exports.x = …` and the properties of
// `module.exports = { … }`. Any other `module.exports = value` is one export.
function commonJsNames(expression: ts.Expression): string[] {
  if (!ts.isBinaryExpression(expression)) return [];
  if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return [];
  const target = expression.left;

  if (isModuleExports(target)) {
    const value = expression.right;
    return ts.isObjectLiteralExpression(value) ? objectLiteralNames(value) : ['default'];
  }
  if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.name)) return [];
  const owner = target.expression;
  const isExports = ts.isIdentifier(owner) && owner.text === 'exports';
  return isExports || isModuleExports(owner) ? [target.name.text] : [];
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  );
}

function objectLiteralNames(literal: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of literal.properties) {
    const name = property.name;
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
      names.push(name.text);
    }
  }
  return names;
}
