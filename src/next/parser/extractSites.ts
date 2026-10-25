import * as ts from 'typescript';

import type { EdgeKind, ImportBinding, ImportSite, ParsedFile } from './types';

type DraftSite = Omit<ImportSite, 'line' | 'column'>;

export function parseFile(file: string, text: string, options: ts.CompilerOptions): ParsedFile {
  const sourceFile = createSourceFile(file, text, options);
  return {
    file,
    sourceFile,
    sites: extractSites(sourceFile),
    directives: collectDirectives(sourceFile),
  };
}

function createSourceFile(file: string, text: string, options: ts.CompilerOptions): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      impliedNodeFormat: impliedNodeFormatFor(file, options),
    },
    true,
    scriptKindFor(file),
  );
}

function impliedNodeFormatFor(file: string, options: ts.CompilerOptions): ts.ResolutionMode {
  try {
    return ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options);
  } catch {
    return undefined;
  }
}

function scriptKindFor(file: string): ts.ScriptKind {
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function extractSites(sourceFile: ts.SourceFile): ImportSite[] {
  const sites: ImportSite[] = [];
  const shadowedRequire =
    sourceFile.text.includes('require') && declaresName(sourceFile, 'require');

  const add = (draft: DraftSite, anchor: ts.Node): void => {
    const start = anchor.getStart(sourceFile);
    const at = sourceFile.getLineAndCharacterOfPosition(start);
    sites.push({ ...draft, line: at.line + 1, column: at.character + 1 });
  };

  const addImportDeclaration = (decl: ts.ImportDeclaration): void => {
    const specifier = decl.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return;
    const clause = decl.importClause;
    if (clause === undefined) {
      add(
        {
          specifier: specifier.text,
          kind: 'side-effect',
          form: 'declaration',
          bindings: [],
          node: specifier,
        },
        specifier,
      );
      return;
    }
    const bindings = importBindings(clause);
    add(
      {
        specifier: specifier.text,
        kind: importKind(clause),
        form: 'declaration',
        bindings,
        node: specifier,
      },
      specifier,
    );
  };

  const addExportDeclaration = (decl: ts.ExportDeclaration): void => {
    const specifier = decl.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return;
    add(
      {
        specifier: specifier.text,
        kind: exportKind(decl),
        form: 'declaration',
        bindings: exportBindings(decl),
        node: specifier,
      },
      specifier,
    );
  };

  const addImportEquals = (decl: ts.ImportEqualsDeclaration): void => {
    const reference = decl.moduleReference;
    if (!ts.isExternalModuleReference(reference)) return;
    const literal = reference.expression;
    if (literal === undefined || !ts.isStringLiteral(literal)) return;
    add(
      {
        specifier: literal.text,
        kind: decl.isTypeOnly ? 'type' : 'require',
        form: 'declaration',
        bindings: [{ local: decl.name.text, imported: '*', typeOnly: decl.isTypeOnly }],
        node: literal,
      },
      literal,
    );
  };

  const addImportType = (node: ts.ImportTypeNode, fromJsDoc: boolean): void => {
    const argument = node.argument;
    if (!ts.isLiteralTypeNode(argument) || !ts.isStringLiteral(argument.literal)) return;
    add(
      {
        specifier: argument.literal.text,
        kind: 'type',
        form: 'type-context',
        bindings: [],
        unsupported: fromJsDoc ? 'jsdoc-import-type' : undefined,
        node: argument.literal,
      },
      argument.literal,
    );
  };

  const addCall = (node: ts.CallExpression): void => {
    const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    if (!isDynamic && !isRequire) return;

    const kind: EdgeKind = isDynamic ? 'dynamic' : 'require';
    const argument = node.arguments[0];

    if (argument === undefined || !isLiteralSpecifier(argument)) {
      const anchor = argument ?? node;
      const draft: DraftSite = {
        specifier: argument === undefined ? '' : argument.getText(sourceFile),
        kind,
        form: 'declaration',
        bindings: [],
        unsupported: 'non-literal',
        node: anchor,
      };
      if (isDynamic) draft.deferred = isDeferred(node);
      add(draft, anchor);
      return;
    }

    const draft: DraftSite = {
      specifier: argument.text,
      kind,
      form: 'declaration',
      bindings: [],
      node: argument,
    };
    if (isDynamic) draft.deferred = isDeferred(node);
    if (isRequire && shadowedRequire) draft.unsupported = 'shadowed-require';
    add(draft, argument);
  };

  const visitJsDoc = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      addImportType(node, true);
      return;
    }
    node.forEachChild(visitJsDoc);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return addImportDeclaration(node);
    if (ts.isExportDeclaration(node)) return addExportDeclaration(node);
    if (ts.isImportEqualsDeclaration(node)) return addImportEquals(node);
    if (ts.isImportTypeNode(node)) return addImportType(node, false);
    if (ts.isCallExpression(node)) addCall(node);

    node.forEachChild(visit);
    for (const doc of jsDocsOf(node)) visitJsDoc(doc);
  };

  visit(sourceFile);
  sites.sort((a, b) => a.line - b.line || a.column - b.column);
  return sites;
}

function importBindings(clause: ts.ImportClause): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  if (clause.name !== undefined) {
    bindings.push({ local: clause.name.text, imported: 'default', typeOnly: clause.isTypeOnly });
  }

  const named = clause.namedBindings;
  if (named === undefined) return bindings;
  if (ts.isNamespaceImport(named)) {
    bindings.push({ local: named.name.text, imported: '*', typeOnly: clause.isTypeOnly });
    return bindings;
  }
  for (const element of named.elements) {
    bindings.push({
      local: element.name.text,
      imported: element.propertyName?.text ?? element.name.text,
      typeOnly: clause.isTypeOnly || element.isTypeOnly,
    });
  }
  return bindings;
}

function importKind(clause: ts.ImportClause): EdgeKind {
  if (clause.isTypeOnly) return 'type';
  if (clause.name !== undefined) return 'static';
  const named = clause.namedBindings;
  if (
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((element) => element.isTypeOnly)
  ) {
    return 'type';
  }
  return 'static';
}

function exportBindings(decl: ts.ExportDeclaration): ImportBinding[] {
  const clause = decl.exportClause;
  if (clause === undefined) return [];
  if (ts.isNamespaceExport(clause)) {
    return [{ local: clause.name.text, imported: '*', typeOnly: decl.isTypeOnly }];
  }

  const bindings: ImportBinding[] = [];
  for (const element of clause.elements) {
    bindings.push({
      local: element.name.text,
      imported: element.propertyName?.text ?? element.name.text,
      typeOnly: decl.isTypeOnly || element.isTypeOnly,
    });
  }
  return bindings;
}

function exportKind(decl: ts.ExportDeclaration): EdgeKind {
  if (decl.isTypeOnly) return 'type';
  const clause = decl.exportClause;
  if (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  ) {
    return 'type';
  }
  return 're-export';
}

function isLiteralSpecifier(
  node: ts.Expression,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isDeferred(call: ts.CallExpression): boolean {
  let child: ts.Node = call;
  let parent = child.parent;

  while (parent !== undefined) {
    if (ts.isFunctionLike(parent)) return !isImmediatelyInvoked(parent);
    if (ts.isClassStaticBlockDeclaration(parent)) return false;
    if (
      ts.isPropertyDeclaration(parent) &&
      parent.initializer !== undefined &&
      containsNode(parent.initializer, child)
    ) {
      return !isStaticModifier(parent);
    }
    if (ts.isSourceFile(parent)) return false;
    child = parent;
    parent = parent.parent;
  }

  return false;
}

function isStaticModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ??
      false)
  );
}

function isImmediatelyInvoked(node: ts.Node): boolean {
  let callee: ts.Node = node;
  let parent = callee.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    callee = parent;
    parent = parent.parent;
  }
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === callee;
}

function containsNode(ancestor: ts.Node, node: ts.Node): boolean {
  return node.pos >= ancestor.pos && node.end <= ancestor.end;
}

function jsDocsOf(node: ts.Node): readonly ts.Node[] {
  return (node as ts.Node & { jsDoc?: readonly ts.Node[] }).jsDoc ?? [];
}

function collectDirectives(sourceFile: ts.SourceFile): string[] {
  const directives: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
  }
  return directives;
}

function declaresName(sourceFile: ts.SourceFile, name: string): boolean {
  const declared = new Set<string>();
  const add = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    if (ts.isIdentifier(node)) declared.add(node.text);
    else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      for (const element of node.elements) {
        if (ts.isBindingElement(element)) add(element.name);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      add(node.name);
    } else if (ts.isImportClause(node)) {
      add(node.name);
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isNamespaceImport(node)
    ) {
      add(node.name);
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return declared.has(name);
}
