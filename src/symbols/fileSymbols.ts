import * as ts from 'typescript';

import { collectBindingNames, hasModifier } from '../parser/syntax';
import type { ImportSite, ParsedFile } from '../parser/types';
import type { DeclKind, HeritageClause } from './types';

export interface LocalDeclaration {
  name: string;
  kind: DeclKind;
  isAsyncFunction: boolean;
  // Fields and no behaviour, judged on this file's syntax alone. A class or
  // interface that extends something is data only if its bases are too, which
  // the index decides once names are resolved.
  dataShape: boolean;
  // Every declaration of the name is an interface or a type alias, so it has no
  // runtime value at all.
  typeOnly: boolean;
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
  owner: 'class' | 'interface';
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
  // Namespaces are not declarations here, but one that shares a name with an
  // interface gives that name a runtime value.
  namespaces: Set<string>;
}

// When one name has several declarations (merging, or a type and a value with
// the same name), the identity takes the kind that can be abstract, so merging
// is "abstract only through the interface rule".
interface DeclarationExtra {
  isAsyncFunction?: boolean;
  aliasOf?: string[];
  dataShape?: boolean;
}

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
    namespaces: new Set(),
  };
  for (const site of parsed.sites) addSiteBindings(symbols, site);
  const visitor = new StatementVisitor(parsed.sourceFile, symbols);
  for (const statement of parsed.sourceFile.statements) visitor.visit(statement);
  return symbols;
}

// Import and re-export declarations reuse the bindings the parser already read
// into each site. A re-export binding's `local` is the name it is exported as.
function addSiteBindings(symbols: FileSymbols, site: ImportSite): void {
  const declaration = site.node.parent;
  if (ts.isImportDeclaration(declaration)) {
    for (const { local, imported } of site.bindings) symbols.imports.set(local, { site, imported });
  } else if (ts.isExportDeclaration(declaration)) {
    if (declaration.exportClause === undefined) symbols.stars.push(site);
    for (const { local, imported } of site.bindings) {
      symbols.exports.set(local, { type: 'reexport', site, imported });
    }
  }
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
  ) {}

  visit(statement: ts.Statement): void {
    if (ts.isExportDeclaration(statement)) this.localExportList(statement);
    else if (ts.isExportAssignment(statement)) this.exportAssignment(statement);
    else if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      this.heritageOwner(statement);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      this.declare(statement, statement.name.text, 'type', {
        aliasOf: typeReferencePath(statement.type),
        dataShape: isDataType(statement.type),
      });
    } else if (ts.isEnumDeclaration(statement)) {
      this.declare(statement, statement.name.text, 'enum', { dataShape: true });
    } else if (ts.isFunctionDeclaration(statement)) {
      const isAsyncFunction = hasModifier(statement, ts.SyntaxKind.AsyncKeyword);
      this.declare(statement, statement.name?.text ?? 'default', 'function', { isAsyncFunction });
    } else if (ts.isVariableStatement(statement)) this.variableStatement(statement);
    else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      this.symbols.namespaces.add(statement.name.text);
    } else if (ts.isExpressionStatement(statement)) this.commonJsExports(statement);
  }

  // `export { a, b as c }` with no `from`: names this file already has.
  private localExportList(decl: ts.ExportDeclaration): void {
    const clause = decl.exportClause;
    if (decl.moduleSpecifier !== undefined || clause === undefined || !ts.isNamedExports(clause)) {
      return;
    }
    for (const element of clause.elements) {
      this.symbols.exports.set(element.name.text, {
        type: 'local',
        name: (element.propertyName ?? element.name).text,
      });
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
    const dataShape = ts.isInterfaceDeclaration(node) ? isDataInterface(node) : isDataClass(node);
    this.declare(node, name, kind, { dataShape });
    this.collectHeritage(
      name,
      ts.isInterfaceDeclaration(node) ? 'interface' : 'class',
      node.heritageClauses,
    );
  }

  private variableStatement(statement: ts.VariableStatement): void {
    for (const declarator of statement.declarationList.declarations) {
      const names = new Set<string>();
      collectBindingNames(declarator.name, names);
      for (const name of names) {
        const initializer = declarator.initializer;
        const isAsyncFunction =
          initializer !== undefined &&
          ts.isArrowFunction(initializer) &&
          hasModifier(initializer, ts.SyntaxKind.AsyncKeyword);
        this.declare(statement, name, 'variable', { isAsyncFunction });
        if (initializer !== undefined && ts.isClassExpression(initializer)) {
          this.collectHeritage(name, 'class', initializer.heritageClauses);
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
    owner: HeritageEntry['owner'],
    clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  ): void {
    for (const clause of clauses ?? []) {
      const kind: HeritageClause =
        clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
      for (const type of clause.types) {
        this.symbols.heritage.push({
          from,
          owner,
          clause: kind,
          name: type.expression.getText(this.sourceFile),
          path: expressionPath(type.expression),
        });
      }
    }
  }

  private declare(node: ts.Node, name: string, kind: DeclKind, extra: DeclarationExtra = {}): void {
    this.addDeclaration(name, kind, extra);
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return;
    const exportedAs = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default' : name;
    this.symbols.exports.set(exportedAs, { type: 'local', name });
  }

  private addDeclaration(name: string, kind: DeclKind, extra: DeclarationExtra = {}): void {
    const existing = this.symbols.declarations.get(name);
    if (existing === undefined) {
      this.symbols.declarations.set(name, {
        name,
        kind,
        isAsyncFunction: extra.isAsyncFunction === true,
        dataShape: extra.dataShape === true,
        typeOnly: isTypeKind(kind),
        ...(extra.aliasOf === undefined ? {} : { aliasOf: extra.aliasOf }),
      });
      return;
    }
    if (KIND_PRECEDENCE.indexOf(kind) < KIND_PRECEDENCE.indexOf(existing.kind))
      existing.kind = kind;
    existing.isAsyncFunction ||= extra.isAsyncFunction === true;
    existing.dataShape &&= extra.dataShape === true;
    existing.typeOnly &&= isTypeKind(kind);
    // A merged name is no longer a plain alias of one other name.
    delete existing.aliasOf;
  }
}

function isTypeKind(kind: DeclKind): boolean {
  return kind === 'interface' || kind === 'type';
}

function isFunctionType(type: ts.TypeNode | undefined): boolean {
  return type !== undefined && (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type));
}

function isDataMember(member: ts.TypeElement): boolean {
  return (
    (ts.isPropertySignature(member) && !isFunctionType(member.type)) ||
    ts.isIndexSignatureDeclaration(member)
  );
}

function hasExtends(node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): boolean {
  return (node.heritageClauses ?? []).some(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
}

// An empty interface or class is a marker (a Nest module, say) unless it
// extends something, in which case it has whatever shape its base has.
function isDataInterface(node: ts.InterfaceDeclaration): boolean {
  return (node.members.length > 0 || hasExtends(node)) && node.members.every(isDataMember);
}

function isDataType(type: ts.TypeNode): boolean {
  if (isFunctionType(type)) return false;
  if (!ts.isTypeLiteralNode(type)) return true;
  return type.members.length > 0 && type.members.every(isDataMember);
}

function isDataClass(node: ts.ClassDeclaration): boolean {
  let fields = 0;
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member)) {
      const initializer = member.initializer;
      const holdsFunction =
        isFunctionType(member.type) ||
        (initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
      if (holdsFunction) return false;
      fields++;
    } else if (
      !ts.isConstructorDeclaration(member) &&
      !ts.isSemicolonClassElement(member) &&
      !ts.isIndexSignatureDeclaration(member)
    ) {
      return false;
    }
  }
  return fields > 0 || hasExtends(node);
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
