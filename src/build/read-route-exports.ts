/**
 * Reads a page's `route` export and a layout's `prefix` export STATICALLY —
 * by parsing the source, never by loading the module.
 *
 * The build has to know a page's declared route before anything is built, and
 * the only other way to learn it is to run the page: import the module, let its
 * top-level code execute, and read the binding. That is a different program
 * from the one being built, with the application's own side effects in it. So
 * this module parses instead, and the price of parsing is that the declaration
 * has to be readable without evaluation — a literal. What cannot be read is
 * REFUSED rather than guessed: a wrong route path that builds is worse than a
 * build that stops and says which file to change.
 *
 * `route` and `prefix` are names the page contract reserves, so this reads them
 * out of whichever file it is given and refuses a computed one wherever it
 * appears — a page that exports `prefix`, or a layout that exports `route`, is
 * using a name the framework already owns.
 *
 * Single responsibility, deliberately: this returns values or a typed
 * rejection and decides nothing. What a rejection costs, and when a page is
 * routed at all, belongs to the caller.
 */
import fs from "node:fs";
import { parse } from "@babel/parser";

/**
 * The AST types are derived from `parse`'s own return type rather than imported
 * from `@babel/types`: the parser resolves its own copy of that package, and a
 * node from one copy is not assignable to the identically-shaped type from the
 * other. Reading the types off the function that produced the nodes cannot
 * disagree with it.
 */
type Statement = ReturnType<typeof parse>["program"]["body"][number];
type Expression = Extract<Statement, { type: "ExpressionStatement" }>["expression"];
type ObjectExpression = Extract<Expression, { type: "ObjectExpression" }>;
type ObjectProperty = Extract<ObjectExpression["properties"][number], { type: "ObjectProperty" }>;

/**
 * Anything that can appear where a value is expected — an expression, or one of
 * the destructuring patterns that are legal in an object literal's value slot
 * and are never a literal string.
 */
type ValueNode = ObjectProperty["value"];

/**
 * A declared route, normalised. The bare-string form (`route = "/list"`) and
 * the object form (`route = { path: "/list" }`) reach the caller identically,
 * because the server resolves them identically — `name` is absent exactly when
 * the source omitted it, which is the caller's signal to derive one.
 */
export type DeclaredRoute = { path: string; name?: string };

/** Which export could not be read, from which file, and what was found instead. */
export type RouteExportsRejection = {
  sourceFile: string;
  exportName: "route" | "prefix";
  /** A sentence fragment naming the form that was found, e.g. "its value is a function call". */
  detail: string;
};

export type RouteExportsReadResult =
  | { ok: true; route?: DeclaredRoute; prefix?: string }
  | { ok: false; rejection: RouteExportsRejection };

const EXAMPLES: Record<"route" | "prefix", string> = {
  route: 'export const route = "/list"; (or export const route = { path: "/list", name: "shop.list" };)',
  prefix: 'export const prefix = "/shop";',
};

/**
 * The one thing an app developer is told when a declaration cannot be read.
 *
 * It names the file, says what was found, says why a literal is required, and
 * shows one — because the reader of this message is someone who wrote perfectly
 * valid TypeScript and needs to know why the build will not take it.
 */
export class NonLiteralRouteExportError extends Error {
  public constructor(public readonly rejection: RouteExportsRejection) {
    const { sourceFile, exportName, detail } = rejection;

    super(
      `Cannot read the \`${exportName}\` export of "${sourceFile}": ${detail}. The build reads ` +
        "route declarations without running your application code, so this value has to be " +
        `written out as a literal. For example: ${EXAMPLES[exportName]}`,
    );

    this.name = "NonLiteralRouteExportError";
  }
}

/**
 * `as const`, `satisfies`, a non-null assertion and parentheses all wrap a value
 * without changing it, so reading through them costs nothing and refusing them
 * would reject declarations that are literal in every sense that matters here.
 */
function unwrap(node: ValueNode): ValueNode {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TypeCastExpression":
    case "ParenthesizedExpression":
      return unwrap(node.expression);
    default:
      return node;
  }
}

/** The string a node denotes, or `undefined` when that needs evaluation to know. */
function stringLiteralOf(node: ValueNode): string | undefined {
  const value = unwrap(node);

  if (value.type === "StringLiteral") return value.value;

  // A template with no substitutions is a string spelled with backticks.
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? value.quasis[0]?.value.raw;
  }

  return undefined;
}

/** A sentence fragment naming what was found, for the developer-facing message. */
function describe(node: ValueNode): string {
  const value = unwrap(node);

  switch (value.type) {
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression":
      return "its value is a function call";
    case "Identifier":
      return `its value is the variable \`${value.name}\``;
    case "MemberExpression":
    case "OptionalMemberExpression":
      return "its value is read off another object";
    case "TemplateLiteral":
      return "its value is a template literal with an expression in it";
    case "ConditionalExpression":
      return "its value depends on a condition";
    case "BinaryExpression":
    case "LogicalExpression":
      return "its value is built by an expression";
    default:
      return "its value is computed rather than written out";
  }
}

type ObjectRead = { ok: true; route: DeclaredRoute } | { ok: false; detail: string };

/**
 * The object form. Unknown keys are IGNORED rather than refused, matching the
 * server, which reads `path` and `name` and lets a page carry whatever else it
 * wants alongside them. A spread is not an unknown key: it can contribute
 * `path` itself, so an object that spreads is an object whose route this cannot
 * claim to have read.
 */
function readRouteObject(node: ObjectExpression): ObjectRead {
  let routePath: string | undefined;
  let routeName: string | undefined;

  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      return { ok: false, detail: "the object spreads another value into itself" };
    }

    if (property.computed) {
      return { ok: false, detail: "one of the object's keys is computed" };
    }

    const { key } = property;
    const keyName =
      key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : undefined;

    if (keyName !== "path" && keyName !== "name") continue;

    if (property.type !== "ObjectProperty") {
      return { ok: false, detail: `\`${keyName}\` is declared as a method` };
    }

    const value = stringLiteralOf(property.value);

    if (value === undefined) {
      return { ok: false, detail: `its \`${keyName}\` is not written as a string literal` };
    }

    if (keyName === "path") routePath = value;
    else routeName = value;
  }

  if (routePath === undefined) {
    return { ok: false, detail: "the object does not declare a `path`" };
  }

  return {
    ok: true,
    route: routeName === undefined ? { path: routePath } : { path: routePath, name: routeName },
  };
}

/**
 * Parses the source, or THROWS when it cannot be parsed at all.
 *
 * A syntax error is not a rejection, deliberately: nothing about the route
 * declaration is known yet, so telling the developer to write a literal would
 * answer a question they did not ask.
 */
function parseSource(sourceFile: string, source: string) {
  try {
    return parse(source, {
      sourceType: "module",
      // Every file this reads is a page or a layout, i.e. `.tsx`.
      plugins: ["typescript", "jsx"],
      errorRecovery: false,
    });
  } catch (error) {
    throw new Error(
      `Cannot read the route declarations of "${sourceFile}": the file could not be parsed ` +
        `(${(error as Error).message}). Fix the syntax error and the build will continue.`,
    );
  }
}

/**
 * Returns the literal `route` and `prefix` this file declares.
 *
 * Absent is not a rejection: a file that declares neither is read successfully
 * with both fields unset, and what THAT means — a page with no public URL, a
 * layout that adds no prefix — is the caller's call to make.
 *
 * `source` is an override for callers that already hold the text; by default
 * the file is read from disk.
 */
export function readRouteExports(sourceFile: string, source?: string): RouteExportsReadResult {
  const text = source ?? fs.readFileSync(sourceFile, "utf-8");
  const ast = parseSource(sourceFile, text);

  const reject = (exportName: "route" | "prefix", detail: string): RouteExportsReadResult => ({
    ok: false,
    rejection: { sourceFile, exportName, detail },
  });

  let route: DeclaredRoute | undefined;
  let prefix: string | undefined;

  for (const statement of ast.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    // `export { route }` hides the value behind a binding this cannot follow
    // without resolving scope — and following it across modules is exactly the
    // evaluation this reader exists to avoid.
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;

      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : specifier.exported.value;

      if (exported === "route" || exported === "prefix") {
        return reject(
          exported,
          "it is exported through an export list rather than declared with `export const`",
        );
      }
    }

    const { declaration } = statement;

    if (declaration?.type !== "VariableDeclaration") continue;

    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier") continue;

      const declared = declarator.id.name;

      if (declared !== "route" && declared !== "prefix") continue;

      if (declarator.init === null || declarator.init === undefined) {
        return reject(declared, "it is declared without a value");
      }

      if (declared === "prefix") {
        const value = stringLiteralOf(declarator.init);

        if (value === undefined) return reject("prefix", describe(declarator.init));

        prefix = value;
        continue;
      }

      const value = stringLiteralOf(declarator.init);

      if (value !== undefined) {
        route = { path: value };
        continue;
      }

      const object = unwrap(declarator.init);

      if (object.type !== "ObjectExpression") return reject("route", describe(declarator.init));

      const read = readRouteObject(object);

      if (!read.ok) return reject("route", read.detail);

      route = read.route;
    }
  }

  return {
    ok: true,
    ...(route === undefined ? {} : { route }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}
