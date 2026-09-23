/**
 * Projection — the compile-time AST transform that strips a page module's
 * eight server exports before the CLIENT graph forms.
 *
 * Removes `export const config/route/middleware/validation/loader/metadata/prefix/sitemap = ...`
 * (const-arrow form) and `export async function loader(...) {...}`
 * (function-declaration form — a page declares these as separate named
 * exports, not one fused object, so both forms are real), plus any import
 * OR top-level declaration that becomes
 * unreferenced ONLY as a result of that removal. The default export (the
 * page component) and every other non-server-named export — including the
 * synchronous, no-argument `register()` lifecycle hook — survive
 * unconditionally, regardless of what they reference — classification is by
 * FILE, not by what an export does with data.
 *
 * ATTRIBUTION APPLIES TO LOCAL DECLARATIONS, NOT JUST IMPORTS. A page or
 * layout hoists things to module scope for two ordinary reasons, and the
 * reference graph tells them apart without guessing:
 *
 *   `const publishCart: Middleware = ...` + `export const middleware =
 *   [publishCart]` (`v5/app/.../products/web/layout.tsx:30,43`) — the only
 *   reader is a server export being removed, so the binding goes with it.
 *
 *   `const COMMON_TIMEZONES = [...]` read by the default export
 *   (`v5/app/.../account/settings.page.tsx:118,129`) — a surviving reader, so
 *   it survives.
 *
 * That is the SAME rule already applied to import bindings, extended to the
 * other binding kind. It is deliberately not a widening of
 * `SERVER_EXPORT_NAMES`, and not "accept what I don't recognise": a
 * declaration is kept when something the client keeps reads it, dropped when
 * nothing does AND dropping it cannot delete a side effect, and REFUSED
 * otherwise — see `isDefinitionShapedInit`.
 *
 * This is NOT Gate A (`resolveId` path refusal), Gate B (inline secret
 * reads) or Gate C (emitted-output verification) — those are separate,
 * later slices. Projection runs first; the gates enforce after.
 */
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import traverseModule from "@babel/traverse";
import path from "node:path";
import type { Plugin } from "vite";
import { readModuleConfig } from "../build/read-module-config";

type BabelTraverse = typeof import("@babel/traverse").default;
const traverse =
  (traverseModule as unknown as { default?: BabelTraverse }).default ??
  (traverseModule as unknown as BabelTraverse);

/**
 * Exported so Gate C (`gate-c-verify.ts`) can re-derive "does the emitted
 * bundle contain a server export as a top-level binding" from this exact set
 * rather than hand-typing a second copy that could drift from projection's
 * own list.
 */
export const SERVER_EXPORT_NAMES = new Set([
  "config",
  "route",
  "middleware",
  "validation",
  "loader",
  "metadata",
  "prefix",
  "sitemap",
]);

type ProjectableModuleKind = "page" | "layout" | "root";

function projectableModuleKind(id: string): ProjectableModuleKind {
  const base = path.basename(id.split("?", 1)[0] ?? id);
  if (base === "root.tsx" || base === "root.ts") return "root";
  if (base === "layout.tsx" || base === "layout.ts" || /\.layout\.tsx?$/.test(base)) {
    return "layout";
  }
  return "page";
}

/** True only for the one server-only binding which projection removes. */
function hasConfigExport(code: string): boolean {
  const program = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
  return program.body.some(
    (statement: any) =>
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration" &&
      statement.declaration.declarations.some(
        (declaration: any) =>
          declaration.id?.type === "Identifier" && declaration.id.name === "config",
      ),
  );
}

/**
 * Projection deliberately has no general purpose scope dependency. This small
 * walk answers the one question that must be exact after `config` is removed:
 * did a surviving runtime expression still read that binding? Property names,
 * type queries and bindings named config are not reads of the module binding.
 */
function hasUnshadowedConfigRead(code: string): boolean {
  const program = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] })
    .program as any;

  const bindsConfig = (node: any): boolean => {
    if (!node) return false;
    if (node.type === "Identifier") return node.name === "config";
    if (node.type === "AssignmentPattern") return bindsConfig(node.left);
    if (node.type === "RestElement") return bindsConfig(node.argument);
    if (node.type === "ObjectPattern")
      return node.properties.some((p: any) => bindsConfig(p.value ?? p.argument));
    if (node.type === "ArrayPattern") return node.elements.some(bindsConfig);
    return false;
  };
  const blockBindsConfig = (statements: any[]): boolean =>
    statements.some((statement) => {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type === "VariableDeclaration")
        return declaration.declarations.some((d: any) => bindsConfig(d.id));
      return (
        (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
        declaration.id?.name === "config"
      );
    });
  let found = false;
  const walk = (node: any, shadowed: boolean, parent?: any, key?: string): void => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, shadowed, parent, key);
      return;
    }
    if (typeof node.type !== "string") return;
    if (
      [
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSNonNullExpression",
        "TSTypeAssertion",
        "TSInstantiationExpression",
      ].includes(node.type)
    ) {
      walk(node.expression, shadowed, node, "expression");
      return;
    }
    if (node.type.startsWith("TS") || node.type === "TypeAnnotation") return;
    if (node.type === "Identifier") {
      const isProperty =
        (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") &&
        key === "property" &&
        !parent.computed;
      const isObjectKey =
        (parent?.type === "ObjectProperty" || parent?.type === "ObjectMethod") &&
        key === "key" &&
        !parent.computed;
      const isBinding =
        (parent?.type === "VariableDeclarator" && key === "id") ||
        ((parent?.type === "FunctionDeclaration" ||
          parent?.type === "FunctionExpression" ||
          parent?.type === "ArrowFunctionExpression") &&
          (key === "id" || key === "params"));
      if (node.name === "config" && !shadowed && !isProperty && !isObjectKey && !isBinding)
        found = true;
      return;
    }
    if (node.type === "CatchClause") {
      const catchesConfig = bindsConfig(node.param) || blockBindsConfig(node.body?.body ?? []);
      walk(node.body, shadowed || catchesConfig, node, "body");
      return;
    }
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      // The RHS runs before the loop binding exists; the body runs inside it.
      walk(node.right, shadowed, node, "right");
      const bindsLoopConfig =
        node.left?.type === "VariableDeclaration" &&
        node.left.declarations.some((declaration: any) => bindsConfig(declaration.id));
      walk(node.body, shadowed || bindsLoopConfig, node, "body");
      return;
    }
    if (node.type === "ForStatement") {
      const bindsLoopConfig =
        node.init?.type === "VariableDeclaration" &&
        node.init.declarations.some((declaration: any) => bindsConfig(declaration.id));
      walk(node.init, shadowed, node, "init");
      walk(node.test, shadowed || bindsLoopConfig, node, "test");
      walk(node.update, shadowed || bindsLoopConfig, node, "update");
      walk(node.body, shadowed || bindsLoopConfig, node, "body");
      return;
    }
    let nestedShadowed = shadowed;
    if (node.type === "Program" || node.type === "BlockStatement")
      nestedShadowed ||= blockBindsConfig(node.body);
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      nestedShadowed ||=
        node.id?.name === "config" ||
        node.params?.some(bindsConfig) ||
        blockBindsConfig(node.body?.body ?? []);
    }
    if (
      node.type === "ObjectMethod" ||
      node.type === "ClassMethod" ||
      node.type === "ClassPrivateMethod"
    ) {
      nestedShadowed ||= node.params?.some(bindsConfig) || blockBindsConfig(node.body?.body ?? []);
    }
    if (node.type === "StaticBlock") nestedShadowed ||= blockBindsConfig(node.body);
    for (const childKey of Object.keys(node)) {
      if (
        [
          "type",
          "start",
          "end",
          "loc",
          "range",
          "extra",
          "leadingComments",
          "trailingComments",
          "innerComments",
        ].includes(childKey)
      )
        continue;
      walk(node[childKey], nestedShadowed, node, childKey);
    }
  };
  walk(program, false);
  return found;
}

/**
 * Recognized client-safe assets that always survive projection untouched,
 * whether imported bare (`import "./x.css"`) or with specifiers
 * (`import styles from "./x.module.css"`) — CSS is explicitly recognized
 * here as a client-safe asset; the rest of this list is the same "never
 * guess, but a known asset extension is not ambiguous" reasoning extended to
 * the other static asset kinds Vite treats as URL/asset imports, not
 * executable code.
 */
const ASSET_EXTENSION_RE =
  /\.(css|scss|sass|less|styl|stylus|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf)(\?.*)?$/i;

/**
 * Top-level statement types that need no ambiguity check and are never
 * touched by removal: import declarations are handled by their own
 * survives/orphaned logic below, and every export (other than the 8 server
 * names) plus type-only declarations survive unconditionally — projection
 * classifies by FILE, not by the data an export touches.
 *
 * `ExportAllDeclaration` (`export * from "./x"` / `export * as ns from
 * "./x"`) is deliberately NOT in this set — it can forward ANY name from its
 * source module, including a server export, and is refused explicitly below
 * rather than assumed safe.
 */
const ALWAYS_SAFE_STATEMENT_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "EmptyStatement",
]);

/**
 * Thrown when projection encounters an attribution-ambiguous top-level
 * statement — the compiler must not guess. Carries the
 * file/statement/fix fields the plugin's `transform` hook formats into the
 * build-failure message — never silently kept or silently dropped.
 */
export class ProjectionAmbiguityError extends Error {
  constructor(
    public readonly file: string,
    public readonly statement: string,
    public readonly line: number,
    public readonly explanation: string,
    public readonly fix: string,
  ) {
    super(
      [
        `Projection refused to guess: an ambiguous top-level statement in the client build.`,
        ``,
        `File: ${file}:${line}`,
        `Statement: ${statement}`,
        `Cause: ${explanation}`,
        `Fix: ${fix}`,
      ].join("\n"),
    );
    this.name = "ProjectionAmbiguityError";
  }
}

export interface ProjectionResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

/** A top-level `const`/`function`/`class` awaiting attribution by reference. */
interface LocalDeclaration {
  stmt: any;
  /** The module-scope names it binds. */
  names: Set<string>;
  /** Whether removing it could delete a side effect — see `isDefinitionShapedInit`. */
  definitionShaped: boolean;
  removed: boolean;
}

function hasSurvivingReader(local: LocalDeclaration, survivingNames: Set<string>): boolean {
  for (const name of local.names) {
    if (survivingNames.has(name)) return true;
  }
  return false;
}

function isKnownSafeAsset(source: string): boolean {
  return ASSET_EXTENSION_RE.test(source);
}

/**
 * The exported-side name of an `ExportSpecifier` — `sitemap` in both
 * `export { x as sitemap }` and `export { sitemap }`. `null` for any other
 * specifier kind (`ExportNamespaceSpecifier` is refused earlier, before this
 * is ever called).
 */
function exportedSpecifierName(specifier: any): string | null {
  if (specifier.type !== "ExportSpecifier") return null;
  const exported = specifier.exported;
  if (exported.type === "Identifier") return exported.name;
  if (exported.type === "StringLiteral") return exported.value;
  return null;
}

/**
 * A re-export by specifier list — `export { x as sitemap } from "m"` (with a
 * source) or `export { x as sitemap }` (a local re-export of an imported or
 * module-scope binding) — reaches the exact same 8 server names the
 * declaration form does, just through a second syntax shape
 * `isServerExportDeclaration` does not parse. One rule inspecting one form
 * while a second form reaches the same place unexamined is exactly the
 * defect shape this function exists to close (canon `1ca1e8ae`).
 */
interface ReexportEdit {
  stmt: any;
  keep: any[];
  remove: any[];
}

/**
 * Matches `export const <name> = ...` only when the declaration has exactly
 * one declarator — every server export in every fixture and v5/app page is
 * written one-const-per-export (`product-details.page.tsx:15-18,42-69,71-74`);
 * a multi-declarator `export const a = 1, b = 2` is left to the ambiguity
 * path below rather than guessing which half is server-only.
 */
function isServerExportDeclaration(stmt: any): boolean {
  if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) return false;
  const decl = stmt.declaration;
  if (decl.type === "VariableDeclaration" && decl.declarations.length === 1) {
    const id = decl.declarations[0].id;
    return id?.type === "Identifier" && SERVER_EXPORT_NAMES.has(id.name);
  }
  if (decl.type === "FunctionDeclaration") {
    return !!decl.id && SERVER_EXPORT_NAMES.has(decl.id.name);
  }
  return false;
}

/**
 * Generic duck-typed AST walk for local declaration attribution.
 * Collects every `Identifier`/`JSXIdentifier` name reachable from `node`,
 * used to retain local declarations referenced after server exports are
 * removed. Import liveness is resolved separately through Babel bindings.
 * Over-collecting a property key can retain an unnecessary local declaration,
 * but cannot remove one that is still needed.
 */
function collectIdentifierNames(node: unknown, names: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifierNames(item, names);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type !== "string") return;
  if (record.type === "Identifier" || record.type === "JSXIdentifier") {
    names.add((record as any).name);
  }
  for (const key of Object.keys(record)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range")
      continue;
    if (
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments" ||
      key === "extra"
    ) {
      continue;
    }
    collectIdentifierNames(record[key], names);
  }
}

function runtimeImportReferences(code: string): Set<string> {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const references = new Set<string>();
  traverse(ast, {
    Program(program) {
      for (const statement of program.get("body")) {
        if (!statement.isImportDeclaration()) continue;
        for (const specifier of statement.get("specifiers")) {
          if ("importKind" in specifier.node && specifier.node.importKind === "type") continue;
          const binding = program.scope.getBinding(specifier.node.local.name);
          if (
            binding?.referencePaths.some(
              (reference) =>
                !reference.findParent(
                  (parent) =>
                    parent.isTSType() ||
                    parent.isTSTypeAnnotation() ||
                    (parent.isExportSpecifier() && parent.node.exportKind === "type") ||
                    (parent.isExportNamedDeclaration() && parent.node.exportKind === "type"),
                ),
            )
          ) {
            references.add(specifier.node.local.name);
          }
        }
      }
      program.stop();
    },
  });
  return references;
}

/** A mixed `export const config = ..., register = ...` declaration. */
interface VariableExportEdit {
  stmt: any;
  keep: any[];
  remove: any[];
}

/**
 * A validation schema is allowed to be assembled in local constants (for
 * example `const validation = { query: v.object(...) }`). Those constants are
 * an explicit part of the server-only `config.validation` value, unlike an
 * arbitrary unread initializer. Keep that narrow exception separate from the
 * ordinary side-effect refusal below.
 */
function configValidationRootNames(declarator: any): Set<string> {
  const names = new Set<string>();
  let init = declarator?.init;
  while (
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "ParenthesizedExpression",
    ].includes(init?.type)
  ) {
    init = init.expression;
  }
  if (init?.type !== "ObjectExpression") return names;
  for (const property of init.properties ?? []) {
    const key = property?.key;
    const keyName =
      key?.type === "Identifier" ? key.name : key?.type === "StringLiteral" ? key.value : undefined;
    if (property?.type === "ObjectProperty" && !property.computed && keyName === "validation") {
      collectIdentifierNames(property.value, names);
    }
  }
  return names;
}

/**
 * Top-level statements that BIND a name, and are therefore attributable by the
 * reference graph rather than by guessing. Everything outside this set and
 * `ALWAYS_SAFE_STATEMENT_TYPES` declares nothing — a bare `console.log("boot")`
 * has no binding to trace a reader from, which is why it stays a hard refusal.
 */
const DECLARATION_STATEMENT_TYPES = new Set([
  "VariableDeclaration",
  "FunctionDeclaration",
  "ClassDeclaration",
]);

function collectPatternNames(node: any, names: Set<string>): void {
  if (!node || typeof node !== "object") return;
  switch (node.type) {
    case "Identifier":
      names.add(node.name);
      return;
    case "ObjectPattern":
      for (const property of node.properties) {
        collectPatternNames(
          property.type === "RestElement" ? property.argument : property.value,
          names,
        );
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements) collectPatternNames(element, names);
      return;
    case "AssignmentPattern":
      collectPatternNames(node.left, names);
      return;
    case "RestElement":
      collectPatternNames(node.argument, names);
      return;
  }
}

/** The names a top-level declaration introduces into module scope. */
function declaredNames(stmt: any): Set<string> {
  const names = new Set<string>();
  if (stmt.type === "VariableDeclaration") {
    for (const declarator of stmt.declarations) collectPatternNames(declarator.id, names);
  } else if (stmt.id?.type === "Identifier") {
    names.add(stmt.id.name);
  }
  return names;
}

/**
 * Whether EVALUATING this initializer can run anything.
 *
 * This is the whole safety argument for removing an unreferenced declaration.
 * A function definition or a literal only creates a value, so dropping it can
 * only drop a binding nothing reads. A call, a `new`, an `await`, a member
 * access (a getter) — those can do work, and "was that work for the server or
 * for the client?" is precisely the question projection must not answer by
 * guessing. `const _ = installPolyfill()` with no reader at all
 * is the shape this predicate exists to refuse rather than silently delete.
 *
 * Conservative by construction: an unrecognized node type is NOT
 * definition-shaped, so a new syntax form arrives as a refusal with a message,
 * never as a silent removal.
 */
function isDefinitionShapedInit(node: any): boolean {
  // `let x;` — a bare binding with nothing to evaluate.
  if (!node) return true;

  switch (node.type) {
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "BigIntLiteral":
    case "RegExpLiteral":
    // A bare identifier read is a binding lookup, not a computation.
    case "Identifier":
      return true;
    case "TemplateLiteral":
      return node.expressions.every((expression: any) => isDefinitionShapedInit(expression));
    case "UnaryExpression":
      return node.operator !== "delete" && isDefinitionShapedInit(node.argument);
    case "ArrayExpression":
      return node.elements.every(
        (element: any) =>
          element === null || (element.type !== "SpreadElement" && isDefinitionShapedInit(element)),
      );
    case "ObjectExpression":
      // Spread and computed keys both evaluate arbitrary expressions; a getter
      // or setter defines a body that runs on ACCESS, which the surviving half
      // could still trigger — none of them are definitions.
      return node.properties.every(
        (property: any) =>
          property.type === "ObjectProperty" &&
          !property.computed &&
          isDefinitionShapedInit(property.value),
      );
    // TS-only wrappers erase at compile time; look through them.
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "TSInstantiationExpression":
    case "ParenthesizedExpression":
      return isDefinitionShapedInit(node.expression);
    default:
      return false;
  }
}

/**
 * Statement-level form of the above. A `class` is excluded on purpose: static
 * blocks, decorators and computed member keys all run at class-definition time,
 * so a class is only ever kept or refused, never silently removed.
 */
function isDefinitionShapedStatement(stmt: any): boolean {
  if (stmt.type === "FunctionDeclaration") return true;
  if (stmt.type !== "VariableDeclaration") return false;
  return stmt.declarations.every((declarator: any) => isDefinitionShapedInit(declarator.init));
}

function removeStatement(s: MagicString, code: string, node: any): void {
  let end = node.end as number;
  // Swallow one trailing newline so a removed statement doesn't leave a
  // blank line behind — cosmetic only, the output's correctness never
  // depends on it.
  if (code[end] === "\r" && code[end + 1] === "\n") end += 2;
  else if (code[end] === "\n") end += 1;
  s.remove(node.start as number, end);
}

function statementSnippet(code: string, node: any): string {
  const firstLine = code.slice(node.start as number, node.end as number).split("\n")[0] ?? "";
  return firstLine.trim();
}

/**
 * The transform itself: parse, remove the 8 server exports and every import
 * orphaned only by that removal, fail closed on anything attribution-
 * ambiguous. `filePath` is only used for error messages — a fence error
 * must name the file.
 */
export function projectModule(code: string, filePath: string): ProjectionResult {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  const s = new MagicString(code);
  const body = ast.program.body as any[];

  const removedServerExports: any[] = [];
  const importDeclarations: any[] = [];
  const localDeclarations: LocalDeclaration[] = [];
  const reexportEdits: ReexportEdit[] = [];
  const reexportEditByStmt = new Map<any, ReexportEdit>();
  const variableExportEdits: VariableExportEdit[] = [];
  const variableExportEditByStmt = new Map<any, VariableExportEdit>();
  const removedServerDeclarators: any[] = [];

  for (const stmt of body) {
    if (stmt.type === "ImportDeclaration") {
      importDeclarations.push(stmt);
      continue;
    }
    const isNamespaceReexport =
      stmt.type === "ExportNamedDeclaration" &&
      stmt.source != null &&
      (stmt.specifiers as any[] | undefined)?.some(
        (specifier) => specifier.type === "ExportNamespaceSpecifier",
      );

    if (stmt.type === "ExportAllDeclaration" || isNamespaceReexport) {
      // `export * from "./source"` (and `export * as ns from "./source"`,
      // which Babel parses as an `ExportNamedDeclaration` carrying an
      // `ExportNamespaceSpecifier` rather than as `ExportAllDeclaration` —
      // hence the second check above) re-exports every name the source
      // module exports, sight unseen.
      // Projection classifies by file and never opens a
      // second file to resolve what a re-export actually forwards — doing so
      // would mean parsing and walking the source module too, i.e. a second
      // parser. Whether the source exports one of the 8 server names is
      // therefore unknowable here, so this is attribution-ambiguous the same
      // way an unrecognized top-level statement is, and gets the same
      // refusal rather than an assumption that it is safe.
      throw new ProjectionAmbiguityError(
        filePath,
        statementSnippet(code, stmt),
        stmt.loc.start.line,
        `a star re-export forwards every name the source module exports, including possibly one of the 8 known server exports (config, route, middleware, validation, loader, metadata, prefix, sitemap) — projection cannot inspect the source module's exports without parsing a second file, so it can't tell whether this leaks a server-only binding into the client bundle`,
        `replace the star re-export with explicit named re-exports (export { ComponentA, ComponentB } from "./source"), listing only the client-safe names`,
      );
    }
    if (
      stmt.type === "ExportNamedDeclaration" &&
      stmt.declaration?.type === "VariableDeclaration"
    ) {
      const declarations = stmt.declaration.declarations as any[];
      const remove = declarations.filter(
        (declarator) =>
          declarator.id?.type === "Identifier" && SERVER_EXPORT_NAMES.has(declarator.id.name),
      );
      if (remove.length > 0) {
        removedServerDeclarators.push(...remove);
        if (remove.length === declarations.length) {
          removedServerExports.push(stmt);
        } else {
          const keep = declarations.filter((declarator) => !remove.includes(declarator));
          const edit: VariableExportEdit = { stmt, keep, remove };
          variableExportEdits.push(edit);
          variableExportEditByStmt.set(stmt, edit);
        }
        continue;
      }
    }
    if (isServerExportDeclaration(stmt)) {
      removedServerExports.push(stmt);
      continue;
    }
    if (
      stmt.type === "ExportNamedDeclaration" &&
      !stmt.declaration &&
      (stmt.specifiers as any[] | undefined)?.length
    ) {
      // Re-export by specifier list, with or without a source — the second
      // form a server export name reaches through, alongside the declaration
      // form above.
      const remove = (stmt.specifiers as any[]).filter((specifier) =>
        SERVER_EXPORT_NAMES.has(exportedSpecifierName(specifier) ?? ""),
      );
      if (remove.length > 0) {
        const keep = (stmt.specifiers as any[]).filter((specifier) => !remove.includes(specifier));
        const edit: ReexportEdit = { stmt, keep, remove };
        reexportEdits.push(edit);
        reexportEditByStmt.set(stmt, edit);
        continue;
      }
    }
    if (ALWAYS_SAFE_STATEMENT_TYPES.has(stmt.type)) continue;
    if (DECLARATION_STATEMENT_TYPES.has(stmt.type)) {
      // Attributable by the reference graph — decided below, once it is known
      // which statements survive. NOT accepted here.
      localDeclarations.push({
        stmt,
        names: declaredNames(stmt),
        definitionShaped: isDefinitionShapedStatement(stmt),
        removed: false,
      });
      continue;
    }

    // Attribution-IMPOSSIBLE: not an import, not one of the 8 known server
    // exports, not another export, not a type-only declaration, and it binds
    // no name for a reader to point at. Fail closed rather than guess which
    // side of the fence it belongs on.
    throw new ProjectionAmbiguityError(
      filePath,
      statementSnippet(code, stmt),
      stmt.loc.start.line,
      `top-level executable code that declares nothing — outside the 8 known server exports (config, route, middleware, validation, loader, metadata, prefix, sitemap), and binding no name, so projection has no reader to attribute it by and can't tell whether it belongs to the server or the client`,
      `move universal static declarations and their imports into export function register(), or mark the code with an explicit .server/.client file; server-only work can instead move inside one of the 8 declared server exports`,
    );
  }

  const removedLocals = new Set<any>();
  const importBindingNames = new Set(
    importDeclarations.flatMap((declaration) =>
      declaration.specifiers.map((specifier: any) => specifier.local?.name).filter(Boolean),
    ),
  );
  const configValidationDependencies = new Set<string>();
  for (const declarator of removedServerDeclarators) {
    if (declarator.id?.name !== "config") continue;
    for (const name of configValidationRootNames(declarator))
      configValidationDependencies.add(name);
  }
  // Follow local schema helpers too: `schema` -> `validation` -> config.
  for (let changed = true; changed;) {
    changed = false;
    for (const local of localDeclarations) {
      if (![...local.names].some((name) => configValidationDependencies.has(name))) continue;
      const reads = new Set<string>();
      collectIdentifierNames(local.stmt, reads);
      for (const own of local.names) reads.delete(own);
      for (const name of reads) {
        if (!configValidationDependencies.has(name)) {
          configValidationDependencies.add(name);
          changed = true;
        }
      }
    }
  }

  /**
   * Every name READ by something that survives projection. Imports are excluded
   * so an import specifier never counts as a use of itself, and a local
   * declaration does not count as a use of ITSELF either — otherwise a
   * self-recursive server-only helper would pin its own binding alive forever.
   *
   * Over-collecting (an object property key, a shadowing parameter) only ever
   * biases toward KEEPING, never toward dropping something still needed — the
   * safe direction for a heuristic that must not guess in the removal
   * direction.
   */
  function collectSurvivingNames(): Set<string> {
    const names = new Set<string>();
    for (const stmt of body) {
      if (stmt.type === "ImportDeclaration") continue;
      if (removedServerExports.includes(stmt) || removedLocals.has(stmt)) continue;
      const own = new Set<string>();
      const reexport = reexportEditByStmt.get(stmt);
      const variableExport = variableExportEditByStmt.get(stmt);
      if (variableExport) {
        // Only the declarators that remain in this mixed export can keep an
        // import or local alive. Reading the removed config declarator here
        // would falsely retain its server-only dependency graph.
        for (const declarator of variableExport.keep) {
          collectIdentifierNames(declarator, own);
          const declared = new Set<string>();
          collectPatternNames(declarator.id, declared);
          for (const name of declared) own.delete(name);
        }
      } else if (reexport) {
        // A specifier's `local` name is a real reference to a module-scope
        // binding ONLY when the export has no source — `export { x as
        // sitemap } from "m"` names "x" as it exists in "m", not anything in
        // THIS file's scope, so it contributes no read here either way.
        if (!reexport.stmt.source) {
          for (const specifier of reexport.keep) {
            own.add(specifier.local.name);
          }
        }
      } else {
        collectIdentifierNames(stmt, own);
        if (DECLARATION_STATEMENT_TYPES.has(stmt.type)) {
          for (const name of declaredNames(stmt)) own.delete(name);
        }
      }
      // Import liveness is decided from the effective projected program below.
      for (const name of importBindingNames) own.delete(name);
      for (const name of own) names.add(name);
    }
    return names;
  }

  // Fixpoint, not one pass: a server-only helper can be reached only through
  // ANOTHER server-only helper, and dropping the first orphans the second.
  let survivingNames = collectSurvivingNames();
  for (let changed = true; changed;) {
    changed = false;
    for (const local of localDeclarations) {
      const isConfigValidationDependency = [...local.names].some((name) =>
        configValidationDependencies.has(name),
      );
      if (local.removed || (!local.definitionShaped && !isConfigValidationDependency)) continue;
      if (hasSurvivingReader(local, survivingNames)) continue;
      local.removed = true;
      removedLocals.add(local.stmt);
      changed = true;
    }
    if (changed) survivingNames = collectSurvivingNames();
  }

  for (const local of localDeclarations) {
    if (local.removed || hasSurvivingReader(local, survivingNames)) continue;

    // Nothing the client keeps reads it, so it belongs to the server exports
    // being removed — but its initializer can RUN, and a side effect is not
    // attributable by the reference graph. Keeping it ships server work to the
    // browser; dropping it deletes a side effect the client may depend on.
    // Refuse rather than pick one.
    throw new ProjectionAmbiguityError(
      filePath,
      statementSnippet(code, local.stmt),
      local.stmt.loc.start.line,
      `a top-level declaration read only by the server exports being removed, but whose initializer executes code rather than just defining a value — projection can't tell whether that work is server-only or a side effect the client depends on`,
      `move universal static declarations and their imports into export function register(), move a server-only initializer inside the export that reads it, or split it into an explicit .server/.client file`,
    );
  }

  for (const stmt of removedServerExports) removeStatement(s, code, stmt);
  for (const stmt of removedLocals) removeStatement(s, code, stmt);
  for (const edit of variableExportEdits) {
    const declaration = edit.stmt.declaration;
    const kept = edit.keep.map((declarator: any) => code.slice(declarator.start, declarator.end));
    s.overwrite(declaration.start, declaration.end, `${declaration.kind} ${kept.join(", ")};`);
  }
  for (const edit of reexportEdits) {
    if (edit.keep.length === 0) removeStatement(s, code, edit.stmt);
    else {
      const specifiers = edit.stmt.specifiers as any[];
      s.overwrite(
        specifiers[0].start,
        specifiers[specifiers.length - 1].end,
        edit.keep.map((specifier: any) => code.slice(specifier.start, specifier.end)).join(", "),
      );
    }
  }
  const referencedImports = runtimeImportReferences(s.toString());

  for (const decl of importDeclarations) {
    const source = decl.source.value as string;
    if (isKnownSafeAsset(source)) continue; // always survives, no orphan check

    // A type-only import — `import type {} from "./x"` / `import type { X }
    // from "./x"` (whole-declaration `importKind: "type"`), or `import {
    // type X } from "./x"` where EVERY specifier is individually marked type
    // — is erased at build; it never emits a runtime binding, so it cannot
    // smuggle a server module into the client bundle no matter what it
    // names or whether anything downstream reads the name. It is therefore
    // always safe, the same way a known asset extension is: skip both the
    // bare-side-effect refusal and the orphan-import removal below.
    //
    // A MIXED import (`import { type A, B } from "./x"`) still has a real
    // value specifier and is not covered by this check — it falls through
    // to the ordinary orphan-import logic beneath, which decides A/B's
    // survival by whether anything still reads their local names.
    const isFullyTypeOnlyImport =
      decl.importKind === "type" ||
      (decl.specifiers.length > 0 &&
        (decl.specifiers as any[]).every((spec) => spec.importKind === "type"));
    if (isFullyTypeOnlyImport) continue;

    if (decl.specifiers.length === 0) {
      // A bare side-effect import that isn't a recognized asset extension is
      // just as attribution-ambiguous as an executable statement — could be
      // a server-only side effect or something the client genuinely needs.
      throw new ProjectionAmbiguityError(
        filePath,
        statementSnippet(code, decl),
        decl.loc.start.line,
        `a bare side-effect import with no recognized client-safe asset extension — projection can't tell if it belongs only to the server exports being removed or must ship to the client`,
        `move universal static declarations and their imports into export function register(), or mark it with an explicit .server/.client file; server-only work can instead move inside one of the 8 declared server exports`,
      );
    }

    const isUsed = decl.specifiers.some((spec: any) => referencedImports.has(spec.local.name));
    if (!isUsed) removeStatement(s, code, decl);
  }

  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: filePath }),
  };
}

export function isProjectableFile(id: string): boolean {
  const base = path.basename(id.split("?", 1)[0] ?? id);
  if (/\.page\.tsx?$/.test(base)) return true;
  if (base === "layout.tsx" || base === "layout.ts") return true;
  // NAMED layouts — `dashboard.layout.tsx` and friends — are subjects too.
  //
  // Only the exact name `layout.tsx` is POSITIONAL (discovered by its folder).
  // A named layout is addressed by import instead, which is a documented part of
  // the contract: `v5/app/src/web/layouts/dashboard.layout.tsx` says so in its
  // own header, and modules opt in with two re-export lines.
  //
  // Projection did not recognise them, and the consequence was not cosmetic.
  // `dashboard.layout.tsx` calls `navService.forUser()` INSIDE its `loader` —
  // exactly where server work belongs. But because the file was not a subject,
  // the loader was never stripped, so its `navService` import survived into the
  // client graph and dragged auth, the user model and three Node builtins with
  // it. The app was right and the subject test was wrong.
  //
  // Matching `*.layout.tsx` rather than a list of known layout names is
  // deliberate: an enumerated list is the shape that has produced every other
  // boundary defect here (canon `eb0c5ee8`).
  if (/\.layout\.tsx?$/.test(base)) return true;
  if (base === "root.tsx") return true;
  return false;
}

/** The framework-only query that exposes a setup module's browser-safe register hook. */
export function isSetupRegisterProjectionFile(id: string): boolean {
  const [file, query] = id.split("?", 2);
  return query === "warlock-setup-register" && path.basename(file ?? "").endsWith(".setup.ts");
}

function assertNoRawSetupValueImport(code: string, filePath: string): void {
  const program = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
  for (const statement of program.body as any[]) {
    const source = statement.source?.value as string | undefined;
    const allSpecifiersAreTypeOnly =
      statement.specifiers?.length > 0 &&
      statement.specifiers.every((specifier: any) =>
        statement.type === "ImportDeclaration"
          ? specifier.importKind === "type"
          : specifier.exportKind === "type",
      );
    const isTypeOnly =
      statement.importKind === "type" ||
      statement.exportKind === "type" ||
      allSpecifiersAreTypeOnly;
    if (
      source !== undefined &&
      (source.endsWith(".setup") || source.endsWith(".setup.ts")) &&
      !isTypeOnly
    ) {
      throw new Error(
        `Projection refused "${filePath}": UI modules may import a setup file only with \`import type\`. The framework loads its projected register hook itself.`,
      );
    }

    if (statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration")
      continue;
  }

  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      record.type === "ImportExpression" &&
      (record.source as any)?.type === "StringLiteral" &&
      /\.setup(?:\.ts)?$/.test((record.source as any).value)
    ) {
      throw new Error(
        `Projection refused "${filePath}": UI modules cannot dynamically import a setup file.`,
      );
    }
    for (const value of Object.values(record)) visit(value);
  };

  visit(program);
}

function assertSetupRegisterSurface(code: string, filePath: string): void {
  const program = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
  for (const statement of program.body as any[]) {
    if (statement.type === "ExportDefaultDeclaration") {
      throw new Error(
        `Projection refused "${filePath}": setup files cannot export a default component.`,
      );
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const names = statement.declaration
      ? statement.declaration.type === "VariableDeclaration"
        ? statement.declaration.declarations.map((declaration: any) => declaration.id?.name)
        : [statement.declaration.id?.name]
      : statement.specifiers.map((specifier: any) => specifier.exported?.name);
    for (const name of names) {
      if (name !== undefined && name !== "config" && name !== "loader" && name !== "register") {
        throw new Error(
          `Projection refused "${filePath}": setup files may expose only config, loader, or register; found "${name}".`,
        );
      }
    }
  }
}

/**
 * Produces the one browser-visible surface of a setup sidecar. The server
 * continues to load the unmodified module for its loader/config exports; this
 * helper is exclusively for the framework's `?warlock-setup-register` edge.
 */
export function projectSetupRegisterModule(
  code: string,
  filePath: string,
): ReturnType<typeof projectModule> {
  assertSetupRegisterSurface(code, filePath);
  return projectModule(code, filePath);
}

const HMR_RUNTIME_SPECIFIER = "@warlock.js/web/client/runtime";

/**
 * The projected module shares its scope with application source, so the helper
 * import must not redeclare a name the application already owns. A suffix is
 * only needed for the deliberately unlikely collision, but making it
 * deterministic keeps the generated HMR module valid for every page shape.
 */
function hmrRegisterModulesBinding(code: string): string {
  const base = "__warlockRegisterModules";
  let binding = base;
  let index = 2;

  while (new RegExp(`\\b${binding}\\b`).test(code)) {
    binding = `${base}${index++}`;
  }

  return binding;
}

/**
 * The client-build Vite plugin. Scoped to `*.page.tsx`/`layout.tsx`/`root.tsx`
 * Source validation runs for both Vite environments: the dev SSR graph must
 * reject legacy authoring too. Only client projection then removes `config`
 * and its exclusive dependency graph.
 */
export function projection(): Plugin {
  return {
    name: "warlock:projection",
    enforce: "pre",
    transform(code, id, options) {
      const setupProjection = isSetupRegisterProjectionFile(id);
      if (!setupProjection && !isProjectableFile(id)) return null;

      try {
        if (!setupProjection) assertNoRawSetupValueImport(code, id);
        if (setupProjection) assertSetupRegisterSurface(code, id);
        // Discovery and the client compiler must share the same closed public
        // surface. Do this before the SSR return: Vite's dev server otherwise
        // lets old `route`/`middleware` exports slip through unexamined.
        // A setup sidecar's config belongs to its paired owner: roots accept
        // `strictMode`, layouts accept `prefix`, and pages accept route keys.
        // Discovery validates that owner-specific shape before this virtual
        // client projection is requested. Parsing it here as a page would
        // reject valid root/layout sidecars during hydration.
        if (!setupProjection) readModuleConfig(id, code, projectableModuleKind(id));
        if (options?.ssr) return null;

        const configExported = hasConfigExport(code);
        const { code: transformed, map } = projectModule(code, id);
        if (configExported && hasUnshadowedConfigRead(transformed)) {
          throw new Error(
            `Projection refused "${id}": a surviving client export or helper reads the server-only \`config\` binding. Move that value into a client-safe export or pass only resolved data to the component.`,
          );
        }
        const registerModules = hmrRegisterModulesBinding(transformed);
        return {
          code:
            `import { registerModules as ${registerModules} } from "${HMR_RUNTIME_SPECIFIER}";\n` +
            `${transformed}\n` +
            `if (import.meta.hot) import.meta.hot.accept((replacement) => { if (replacement) ${registerModules}([replacement]); });\n`,
          map,
        };
      } catch (error) {
        if (error instanceof ProjectionAmbiguityError) {
          this.error(error.message);
        }
        throw error;
      }
    },
  };
}
