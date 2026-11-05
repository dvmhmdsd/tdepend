import * as ts from 'typescript';

import type { EdgeKind, ImportBinding, ImportSite, ParsedFile } from './types';

type DraftSite = Omit<ImportSite, 'line' | 'column'>;

// `absolutePath` lets TypeScript find the nearest package.json for the implied
// module format; a root-relative path would be read against the process cwd.
export function parseFile(
  file: string,
  text: string,
  options: ts.CompilerOptions,
  absolutePath: string = file,
): ParsedFile {
  const sourceFile = createSourceFile(file, text, options, absolutePath);
  return {
    file,
    sourceFile,
    sites: extractSites(sourceFile),
    directives: collectDirectives(sourceFile),
  };
}

function createSourceFile(
  file: string,
  text: string,
  options: ts.CompilerOptions,
  absolutePath: string,
): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      impliedNodeFormat: impliedNodeFormatFor(absolutePath, options),
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
  const scopeInfo = sourceFile.text.includes('require') ? buildScopeInfo(sourceFile) : null;

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
    if (isRequire && scopeInfo !== null && isRequireShadowed(scopeInfo, node)) {
      draft.unsupported = 'shadowed-require';
    }
    add(draft, argument);
  };

  const addJsDocImportTag = (tag: ts.JSDocImportTag): void => {
    const specifier = tag.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) return;
    add(
      {
        specifier: specifier.text,
        kind: 'type',
        form: 'type-context',
        bindings: [],
        unsupported: 'jsdoc-import-type',
        node: specifier,
      },
      specifier,
    );
  };

  const visitJsDoc = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      addImportType(node, true);
      return;
    }
    if (ts.isJSDocImportTag(node)) {
      addJsDocImportTag(node);
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

// Code that runs in place, such as an immediately invoked function or a static
// initialiser, delays nothing itself, so the walk goes on to whatever encloses it.
function isDeferred(call: ts.CallExpression): boolean {
  let child: ts.Node = call;

  for (let parent = child.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && !isImmediatelyInvoked(parent)) return true;
    if (isInstanceInitializer(parent, child)) return true;
    child = parent;
  }

  return false;
}

function isInstanceInitializer(node: ts.Node, child: ts.Node): boolean {
  return (
    ts.isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    containsNode(node.initializer, child) &&
    !isStaticModifier(node)
  );
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

interface ValueScope {
  parent: ValueScope | null;
  bindings: Set<string>;
  ownsVars: boolean;
  strict: boolean;
}

interface ScopeInfo {
  scopeOf: WeakMap<ts.Node, ValueScope>;
}

function buildScopeInfo(sourceFile: ts.SourceFile): ScopeInfo {
  const scopeOf = new WeakMap<ts.Node, ValueScope>();
  const analysis = analyzeScopes(sourceFile);
  const root: ValueScope = {
    parent: null,
    bindings: new Set(),
    ownsVars: true,
    strict: isStrictSource(sourceFile),
  };
  scopeOf.set(sourceFile, root);
  const stack: ValueScope[] = [root];

  const current = (): ValueScope => stack[stack.length - 1];
  const enclosingScopeOf = (node: ts.Node): ValueScope => {
    for (let ancestor = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
      const scope = scopeOf.get(ancestor);
      if (scope !== undefined) return scope;
    }
    return root;
  };
  const varScope = (): ValueScope => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].ownsVars) return stack[index];
    }
    return root;
  };
  const push = (node: ts.Node, ownsVars: boolean, strict: boolean): ValueScope => {
    const scope: ValueScope = {
      parent: enclosingScopeOf(node),
      bindings: new Set(),
      ownsVars,
      strict,
    };
    scopeOf.set(node, scope);
    stack.push(scope);
    return scope;
  };
  const addBinding = (name: ts.BindingName, scope: ValueScope): void => {
    collectBindingNames(name, scope.bindings);
  };
  const inheritStrict = (node: ts.Node): boolean => enclosingScopeOf(node).strict;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      const enclosing = enclosingScopeOf(node);
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        const name = node.name.text;
        enclosing.bindings.add(name);
        if (
          !enclosing.strict &&
          isPlainFunction(node) &&
          !isHoistBlocked(node, name, analysis.lexicalNames)
        ) {
          varScope().bindings.add(name);
        }
      }
      if (node.name !== undefined && ts.isComputedPropertyName(node.name)) {
        scopeOf.set(node.name, enclosing);
      }
      for (const decorator of decoratorsOf(node)) scopeOf.set(decorator, enclosing);
      for (const parameter of node.parameters) {
        for (const decorator of decoratorsOf(parameter)) scopeOf.set(decorator, enclosing);
      }
      const body = (node as ts.FunctionLikeDeclaration).body;
      const strict =
        enclosing.strict || (body !== undefined && ts.isBlock(body) && hasUseStrictPrologue(body));
      const scope = push(node, false, strict);
      if (ts.isFunctionExpression(node) && node.name !== undefined) {
        scope.bindings.add(node.name.text);
      }
      for (const parameter of node.parameters) addBinding(parameter.name, scope);
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isClassStaticBlockDeclaration(node)) {
      push(node, true, true);
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isClassExpression(node)) {
      const scope = push(node, false, true);
      if (node.name !== undefined) scope.bindings.add(node.name.text);
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isClassDeclaration(node)) {
      if (node.name !== undefined) current().bindings.add(node.name.text);
      push(node, false, true);
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isModuleBlock(node)) {
      push(node, true, inheritStrict(node));
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (
      ts.isCaseBlock(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      push(node, false, inheritStrict(node));
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isBlock(node)) {
      push(node, isFunctionBody(node), inheritStrict(node));
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isCatchClause(node)) {
      const scope = push(node, false, inheritStrict(node));
      if (node.variableDeclaration !== undefined) addBinding(node.variableDeclaration.name, scope);
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isVariableDeclarationList(node)) {
      const target = (node.flags & ts.NodeFlags.BlockScoped) !== 0 ? current() : varScope();
      for (const declaration of node.declarations) addBinding(declaration.name, target);
      node.forEachChild(visit);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      current().bindings.add(node.name.text);
      node.forEachChild(visit);
      return;
    }

    if (ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name) && namespaceHasValue(node)) {
        current().bindings.add(node.name.text);
      }
      const scope = push(node, false, inheritStrict(node));
      const exports = analysis.namespaceExports.get(qualifiedNamespaceName(node));
      if (exports !== undefined) for (const name of exports) scope.bindings.add(name);
      node.forEachChild(visit);
      stack.pop();
      return;
    }

    if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly) current().bindings.add(node.name.text);
      node.forEachChild(visit);
      return;
    }

    if (ts.isImportDeclaration(node)) {
      addImportBindings(node, current());
      return;
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return { scopeOf };
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function hasUseStrictPrologue(node: ts.SourceFile | ts.Block): boolean {
  for (const statement of node.statements) {
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
      if (statement.expression.text === 'use strict') return true;
    } else {
      break;
    }
  }
  return false;
}

function isStrictSource(sourceFile: ts.SourceFile): boolean {
  return ts.isExternalModule(sourceFile) || hasUseStrictPrologue(sourceFile);
}

function isFunctionBody(block: ts.Block): boolean {
  const parent = block.parent;
  return ts.isFunctionLike(parent) && (parent as ts.FunctionLikeDeclaration).body === block;
}

interface ScopeAnalysis {
  lexicalNames: Map<ts.Node, Set<string>>;
  namespaceExports: Map<string, Set<string>>;
}

function analyzeScopes(sourceFile: ts.SourceFile): ScopeAnalysis {
  const lexicalNames = new Map<ts.Node, Set<string>>();
  const namespaceExports = new Map<string, Set<string>>();

  const visit = (node: ts.Node): void => {
    if (isLexicalScope(node)) lexicalNames.set(node, directLexicalNames(node));
    if (ts.isModuleDeclaration(node)) {
      const key = qualifiedNamespaceName(node);
      const body = node.body;
      if (
        body !== undefined &&
        ts.isModuleBlock(body) &&
        !hasModifier(node, ts.SyntaxKind.DeclareKeyword)
      ) {
        const names = namespaceExports.get(key) ?? new Set<string>();
        for (const statement of body.statements) {
          for (const name of exportedValueNames(statement)) names.add(name);
        }
        namespaceExports.set(key, names);
      }
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return { lexicalNames, namespaceExports };
}

function isLexicalScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

function statementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isClassStaticBlockDeclaration(node)) return node.body.statements;
  return undefined;
}

function directLexicalNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const statements = statementsOf(node);
  if (statements === undefined) return names;
  for (const statement of statements) {
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
    ) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function namespaceHasValue(node: ts.ModuleDeclaration): boolean {
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return false;
  const body = node.body;
  if (body === undefined) return false;
  if (ts.isModuleBlock(body)) return body.statements.some(statementHasValue);
  if (ts.isModuleDeclaration(body)) return namespaceHasValue(body);
  return false;
}

function statementHasValue(statement: ts.Statement): boolean {
  if (
    ts.isVariableStatement(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement)
  ) {
    return true;
  }
  if (ts.isModuleDeclaration(statement)) return namespaceHasValue(statement);
  return false;
}

function exportedValueNames(statement: ts.Statement): string[] {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (ts.isVariableStatement(statement)) {
    const names = new Set<string>();
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
    return [...names];
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name !== undefined && ts.isIdentifier(statement.name)
      ? [statement.name.text]
      : [];
  }
  if (ts.isImportEqualsDeclaration(statement)) return [statement.name.text];
  return [];
}

function qualifiedNamespaceName(node: ts.ModuleDeclaration): string {
  const parts: string[] = [];
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isModuleDeclaration(current) && ts.isIdentifier(current.name)) {
      parts.unshift(current.name.text);
    }
  }
  return parts.join('.');
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function isPlainFunction(node: ts.FunctionDeclaration): boolean {
  return node.asteriskToken === undefined && !hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function isHoistBlocked(
  node: ts.FunctionDeclaration,
  name: string,
  lexicalNames: Map<ts.Node, Set<string>>,
): boolean {
  for (let ancestor = node.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    const names = lexicalNames.get(ancestor);
    if (names !== undefined && names.has(name)) return true;
    if (isVarBoundary(ancestor)) return false;
  }
  return false;
}

function isVarBoundary(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    (ts.isBlock(node) && isFunctionBody(node))
  );
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out);
  }
}

function addImportBindings(decl: ts.ImportDeclaration, scope: ValueScope): void {
  const clause = decl.importClause;
  if (clause === undefined || clause.isTypeOnly) return;
  if (clause.name !== undefined) scope.bindings.add(clause.name.text);

  const named = clause.namedBindings;
  if (named === undefined) return;
  if (ts.isNamespaceImport(named)) {
    scope.bindings.add(named.name.text);
    return;
  }
  for (const element of named.elements) {
    if (!element.isTypeOnly) scope.bindings.add(element.name.text);
  }
}

function isRequireShadowed(info: ScopeInfo, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    const scope = info.scopeOf.get(current);
    if (scope === undefined) continue;
    for (
      let candidate: ValueScope | null = scope;
      candidate !== null;
      candidate = candidate.parent
    ) {
      if (candidate.bindings.has('require')) return true;
    }
    return false;
  }
  return false;
}
