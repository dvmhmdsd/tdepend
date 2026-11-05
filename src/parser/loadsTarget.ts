import * as ts from 'typescript';

import type { ImportSite, LoadReason, ParsedFile } from './types';

export type Compiler = 'tsc' | 'esbuild' | 'swc';

export type { LoadReason };

export interface LoadVerdict {
  loadsTarget: boolean;
  loadsTargetBy: LoadReason;
  reason: string;
}

const TS_FAMILY = /\.(ts|tsx|mts|cts)$/i;

// A site loads its target unless every declared compiler erases it. The rules
// below read the file's own compiler options plus the declared compilers, so a
// repo can narrow the contract with `compilers`.
export function classifyLoads(
  parsed: ParsedFile,
  site: ImportSite,
  options: ts.CompilerOptions,
  typeOnly: 'usage' | 'syntax',
  compilers: Compiler[],
): LoadVerdict {
  if (site.form === 'type-context') {
    return erased('syntax', 'a type-context import is erased by every compiler');
  }

  if (site.kind === 'type') {
    if (isWholeTypeDeclaration(site)) {
      return erased(
        'syntax',
        'a whole-declaration type-only import or re-export is erased by every compiler',
      );
    }
    if (keepsVerbatim(options)) {
      return retained(
        'an inline type-only import under verbatimModuleSyntax still evaluates the module',
      );
    }
    return erased('syntax', 'inline type-only specifiers are erased by every compiler');
  }

  if (site.kind === 're-export') {
    return classifyReExport(parsed, site, options, compilers);
  }

  if (site.kind === 'require' || site.kind === 'side-effect' || site.kind === 'dynamic') {
    return retained(`a ${site.kind} import is evaluated and every compiler keeps it`);
  }

  return classifyStatic(parsed, site, options, typeOnly, compilers);
}

function classifyReExport(
  parsed: ParsedFile,
  site: ImportSite,
  options: ts.CompilerOptions,
  compilers: Compiler[],
): LoadVerdict {
  const declaration = exportDeclarationOf(site);
  const clause = declaration?.exportClause;

  if (clause === undefined || ts.isNamespaceExport(clause)) {
    return retained('a namespace re-export is evaluated by every compiler');
  }

  if (clause.elements.length === 0) {
    if (TS_FAMILY.test(parsed.file) && !keepsVerbatim(options)) {
      return erased(
        'syntax',
        'an empty re-export is erased in a TypeScript file without verbatimModuleSyntax',
      );
    }
    return retained('an empty re-export is kept by esbuild and swc, and by native ESM');
  }

  return retained('an unmarked named re-export is kept until every name is known to be a type');
}

function classifyStatic(
  parsed: ParsedFile,
  site: ImportSite,
  options: ts.CompilerOptions,
  typeOnly: 'usage' | 'syntax',
  compilers: Compiler[],
): LoadVerdict {
  if (site.bindings.length === 0) {
    if (keepsVerbatim(options) || compilers.includes('swc')) {
      return retained('an empty import is kept by swc as a side-effect import');
    }
    return erased('syntax', 'an empty import is erased by every declared compiler');
  }

  if (!TS_FAMILY.test(parsed.file)) {
    return retained('a static import in a JavaScript file is kept exactly as written');
  }

  if (keepsVerbatim(options) || options.preserveValueImports === true || preservesUnused(options)) {
    return retained('the file keeps an unused import under its compiler options');
  }

  if (typeOnly === 'syntax') {
    return retained('typeOnly is syntax, so every static import is kept');
  }

  const facts = fileFacts(parsed.sourceFile, options);
  if (site.bindings.some((binding) => facts.valueNames.has(binding.local))) {
    return retained('at least one binding is used as a value');
  }
  return erased('usage', 'every binding is used only in a type position, or not at all');
}

function erased(loadsTargetBy: LoadReason, reason: string): LoadVerdict {
  return { loadsTarget: false, loadsTargetBy, reason };
}

function retained(reason: string): LoadVerdict {
  return { loadsTarget: true, loadsTargetBy: 'retained', reason };
}

function keepsVerbatim(options: ts.CompilerOptions): boolean {
  return options.verbatimModuleSyntax === true;
}

function preservesUnused(options: ts.CompilerOptions): boolean {
  return (
    options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Preserve ||
    options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Error
  );
}

function isWholeTypeDeclaration(site: ImportSite): boolean {
  const parent = site.node.parent;
  if (ts.isImportDeclaration(parent)) {
    return parent.importClause?.isTypeOnly === true;
  }
  if (ts.isExportDeclaration(parent)) {
    return parent.isTypeOnly;
  }
  if (ts.isExternalModuleReference(parent)) {
    const owner = parent.parent;
    return ts.isImportEqualsDeclaration(owner) && owner.isTypeOnly;
  }
  return false;
}

function exportDeclarationOf(site: ImportSite): ts.ExportDeclaration | undefined {
  const parent = site.node.parent;
  return ts.isExportDeclaration(parent) ? parent : undefined;
}

interface FileFacts {
  valueNames: Set<string>;
}

const FILE_FACTS = new WeakMap<ts.SourceFile, FileFacts>();

function fileFacts(sourceFile: ts.SourceFile, options: ts.CompilerOptions): FileFacts {
  const cached = FILE_FACTS.get(sourceFile);
  if (cached !== undefined) return cached;
  const facts = collectFileFacts(sourceFile, options);
  FILE_FACTS.set(sourceFile, facts);
  return facts;
}

// One name-matching pass over the file. A name counts as a value use when it
// appears outside a type position and outside the import statements, so the
// scan never treats the import that declares it as a use of itself. Scopes are
// not analysed: a shadowing local or parameter counts too, which keeps the
// result conservative.
function collectFileFacts(sourceFile: ts.SourceFile, options: ts.CompilerOptions): FileFacts {
  const valueNames = new Set<string>();
  const metadataOn =
    options.experimentalDecorators === true && options.emitDecoratorMetadata === true;
  let hasJsx = false;

  const record = (name: string): void => {
    valueNames.add(name);
  };

  const visit = (node: ts.Node, inType: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) return;
      const clause = node.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause) && !node.isTypeOnly) {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) record((element.propertyName ?? element.name).text);
        }
      }
      return;
    }

    if (ts.isExportAssignment(node)) {
      visit(node.expression, false);
      return;
    }

    if (ts.isHeritageClause(node)) {
      visitHeritageClause(node, visit);
      return;
    }

    if (ts.isExpressionWithTypeArguments(node)) {
      if (!inType) visit(node.expression, false);
      return;
    }

    if (inType || ts.isTypeNode(node)) {
      if (ts.isComputedPropertyName(node)) visit(node.expression, false);
      else node.forEachChild((child) => visit(child, true));
      return;
    }

    if (ts.isIdentifier(node) && isReference(node)) record(node.text);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      hasJsx = true;
    }
    if (metadataOn) recordDeclaredTypes(node, record);

    node.forEachChild((child) =>
      visit(child, ts.isTypeNode(child) && !ts.isExpressionWithTypeArguments(child)),
    );
  };

  visit(sourceFile, false);

  // tsc and swc keep the factory import under every `jsx` setting, even the
  // automatic runtime that never calls it.
  if (hasJsx) record(options.jsxFactory ?? 'React');

  return { valueNames };
}

function visitHeritageClause(
  clause: ts.HeritageClause,
  visit: (node: ts.Node, inType: boolean) => void,
): void {
  const owner = clause.parent;
  const classExtends =
    (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) &&
    clause.token === ts.SyntaxKind.ExtendsKeyword;
  if (!classExtends) return;

  for (const type of clause.types) {
    visit(type.expression, false);
    for (const argument of type.typeArguments ?? []) visit(argument, true);
  }
}

// tsc and swc serialise only the leftmost name of a type reference
// (`Promise<Dto>` becomes `Promise`), so only that name is a value use.
function recordDeclaredTypes(node: ts.Node, record: (name: string) => void): void {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    if (!hasDecorator(node) && !node.parameters.some(hasDecorator)) return;
    for (const parameter of node.parameters) recordMetadataType(parameter.type, record);
    recordMetadataType(node.type, record);
    return;
  }

  if (ts.isPropertyDeclaration(node)) {
    if (hasDecorator(node)) recordMetadataType(node.type, record);
    return;
  }

  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const constructors = node.members.filter(ts.isConstructorDeclaration);
    const parameters = constructors.flatMap((constructor) => [...constructor.parameters]);
    if (!hasDecorator(node) && !parameters.some(hasDecorator)) return;
    for (const parameter of parameters) recordMetadataType(parameter.type, record);
  }
}

function recordMetadataType(
  type: ts.TypeNode | undefined,
  record: (name: string) => void,
): void {
  if (type === undefined) return;
  if (ts.isTypeReferenceNode(type)) {
    record(leftmostName(type.typeName));
    return;
  }
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    recordMetadataType(type.type, record);
    return;
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    for (const member of type.types) recordMetadataType(member, record);
    return;
  }
  if (ts.isConditionalTypeNode(type)) {
    recordMetadataType(type.trueType, record);
    recordMetadataType(type.falseType, record);
  }
}

function leftmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmostName(name.left);
}

function hasDecorator(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}
