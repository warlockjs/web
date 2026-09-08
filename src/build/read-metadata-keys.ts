/**
 * Checks a page's `metadata` export for a key nothing reads — by parsing the
 * source, never by loading the module.
 *
 * THE POINT OF THIS ERROR IS THE UNANNOTATED CASE. A page that writes
 * `export const metadata: PageMetadata = { tittle: "x" }` is already refused by
 * TypeScript, and if that were the whole story this module would not need to
 * exist. But the annotation is optional, nobody writes it, and
 * `export const metadata = { tittle: "x" }` is a perfectly well-typed program:
 * the compiler infers `{ tittle: string }`, has nothing to check it against,
 * and says nothing. The page is then served with no `<title>` — not a wrong
 * title, a missing one — and no error is raised anywhere, at build or at
 * runtime, ever.
 *
 * So the check lives here instead, at the gate every page already passes
 * through: a page that silently omits requested metadata is worse than a
 * build that stops and says which line to fix.
 *
 * Single responsibility, deliberately: this returns the unknown keys it finds
 * and decides nothing. What that costs the build belongs to the caller.
 */
import { parse } from "@babel/parser";
import { METADATA_KEYS, OPEN_GRAPH_KEYS, TWITTER_KEYS } from "../metadata";

/** One key a page's `metadata` declares that nothing reads, and where it is written. */
export type UnknownMetadataKey = {
  /** The object it was declared in: `metadata`, `metadata.openGraph`, `metadata.twitter`. */
  container: string;
  /** The key exactly as the page wrote it. */
  key: string;
  /** 1-based line in the page file, so the message points at the character that is wrong. */
  line: number;
  /** The known key it is within two edits of, when there is one. Usually the whole answer. */
  suggestion?: string;
};

/**
 * Raised when a page's `metadata` export declares a key nothing reads.
 *
 * THE POINT OF THIS ERROR IS THE UNANNOTATED CASE. A page that writes
 * `export const metadata: PageMetadata = { tittle: "x" }` is already refused by
 * TypeScript, and if that were the whole story this class would not need to
 * exist. But the annotation is optional, nobody writes it, and
 * `export const metadata = { tittle: "x" }` is a perfectly well-typed program:
 * the compiler infers `{ tittle: string }`, has nothing to check it against, and
 * says nothing. The page is then served with no `<title>` — not a wrong title, a
 * missing one — and no error is raised anywhere, at build or at runtime, ever.
 *
 * So the check lives HERE instead, at the gate every page already passes
 * through: a page that silently omits requested metadata is worse than a build
 * that stops and says which line to fix.
 *
 * The alternative considered and rejected was a `defineMetadata({...})` wrapper,
 * which would infer the type for free. It also puts framework ceremony in every
 * page, and a page is meant to be two lines of framework surface (canon
 * `6ea0662f`). The gate gets the same safety without spending that.
 */
export class UnknownMetadataKeyError extends Error {
  public constructor(
    public readonly pageFile: string,
    public readonly unknownKeys: readonly UnknownMetadataKey[],
  ) {
    const findings = unknownKeys
      .map(({ container, key, line, suggestion }) => {
        const where = `line ${line}: \`${container}.${key}\` — no such key.`;

        return suggestion === undefined ? where : `${where} Did you mean \`${suggestion}\`?`;
      })
      .join("\n  ");

    super(
      `The \`metadata\` export of "${pageFile}" declares a key nothing reads:\n  ${findings}\n` +
        "Nothing writes an unknown key to `<head>`, so the tag it was meant to produce would " +
        "simply be absent from every response, with no error at build time or at runtime. The " +
        "build refuses it here instead.\n" +
        `  Known keys: ${METADATA_KEYS.join(", ")}.\n` +
        `  Inside \`openGraph\`: ${OPEN_GRAPH_KEYS.join(", ")}.\n` +
        `  Inside \`twitter\`: ${TWITTER_KEYS.join(", ")}.\n` +
        "Annotating the export — `export const metadata: PageMetadata = { … }` — gets you the " +
        "same list as autocomplete in the editor, before the build runs.",
    );
    this.name = "UnknownMetadataKeyError";
  }
}

/**
 * The AST types, derived from `parse`'s own return type rather than imported
 * from `@babel/types`, for the reason `read-route-exports.ts` gives: the parser
 * resolves its own copy of that package and nodes from one copy are not
 * assignable to the identical types from the other.
 */
type PageStatement = ReturnType<typeof parse>["program"]["body"][number];
type PageExpression = Extract<PageStatement, { type: "ExpressionStatement" }>["expression"];
type PageObjectExpression = Extract<PageExpression, { type: "ObjectExpression" }>;
type PageObjectProperty = Extract<
  PageObjectExpression["properties"][number],
  { type: "ObjectProperty" }
>;
type PageValueNode = PageObjectProperty["value"];

/** `as const`, `satisfies`, `!` and parentheses wrap a value without changing it. */
function unwrapValue(node: PageValueNode): PageValueNode {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TypeCastExpression":
    case "ParenthesizedExpression":
      return unwrapValue(node.expression);
    default:
      return node;
  }
}

/** Levenshtein distance — small strings, so the plain two-row table is the whole cost. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row++) {
    const current = [row];

    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(substitution, previous[column] + 1, current[column - 1] + 1);
    }

    previous = current;
  }

  return previous[right.length];
}

/**
 * The known key the written one was probably meant to be.
 *
 * Two edits, because that covers the typos this exists for — `tittle`,
 * `descriptoin`, `keywrods` — without reaching so far that `image` gets
 * suggested for `alt`. Case is ignored first, so `Title` resolves exactly.
 */
function suggestKey(written: string, known: readonly string[]): string | undefined {
  const lowered = written.toLowerCase();
  const sameLetters = known.find((candidate) => candidate.toLowerCase() === lowered);

  if (sameLetters !== undefined) return sameLetters;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of known) {
    const distance = editDistance(lowered, candidate.toLowerCase());

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return bestDistance <= 2 ? best : undefined;
}

/** The name an object key denotes, or `undefined` when knowing it needs evaluation. */
function propertyKeyName(property: PageObjectProperty): string | undefined {
  if (property.computed) return undefined;

  const { key } = property;

  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;

  return undefined;
}

/** The nested objects that carry a key set of their own. */
const NESTED_METADATA_KEYS: Record<string, readonly string[]> = {
  openGraph: OPEN_GRAPH_KEYS,
  twitter: TWITTER_KEYS,
};

/**
 * Every unknown key in one metadata object literal, and in the `openGraph` /
 * `twitter` literals inside it.
 *
 * A SPREAD does not suppress the check, unlike the route reader's rule: a
 * spread can only ADD keys, and no value it contributes can make a key written
 * out beside it correct. A COMPUTED key is skipped — its name is not knowable
 * without running the page, and refusing what cannot be read would fail builds
 * that are fine. Both are silence in the narrow places where the parse genuinely
 * does not know, and the annotation is the second net there.
 */
function collectUnknownKeys(
  object: PageObjectExpression,
  allowed: readonly string[],
  container: string,
  into: UnknownMetadataKey[],
): void {
  for (const property of object.properties) {
    if (property.type === "SpreadElement") continue;

    const key = propertyKeyName(property as PageObjectProperty);

    if (key === undefined) continue;

    if (!allowed.includes(key)) {
      const suggestion = suggestKey(key, allowed);

      into.push({
        container,
        key,
        line: property.loc?.start.line ?? 0,
        ...(suggestion === undefined ? {} : { suggestion }),
      });

      continue;
    }

    const nested = container === "metadata" ? NESTED_METADATA_KEYS[key] : undefined;

    if (nested === undefined || property.type !== "ObjectProperty") continue;

    const value = unwrapValue(property.value);

    if (value.type === "ObjectExpression") {
      collectUnknownKeys(value, nested, `${container}.${key}`, into);
    }
  }
}

/**
 * Every object literal a function form RETURNS, without descending into
 * functions nested inside it — a callback's return value is not the metadata.
 *
 * A generic walk rather than a statement-by-statement one because a `return` is
 * legal anywhere a statement is: inside an `if`, a `switch`, a `try`. Enumerating
 * the statement types that may contain one is a list that is wrong the moment
 * the language grows.
 */
function collectReturnedObjects(node: unknown, into: PageObjectExpression[]): void {
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) collectReturnedObjects(item, into);

    return;
  }

  const candidate = node as { type?: string; argument?: unknown };

  if (
    candidate.type === "FunctionDeclaration" ||
    candidate.type === "FunctionExpression" ||
    candidate.type === "ArrowFunctionExpression" ||
    candidate.type === "ObjectMethod" ||
    candidate.type === "ClassMethod"
  ) {
    return;
  }

  if (candidate.type === "ReturnStatement") {
    if (candidate.argument === null || candidate.argument === undefined) return;

    const returned = unwrapValue(candidate.argument as PageValueNode);

    if (returned.type === "ObjectExpression") into.push(returned);

    // Not descending into the returned value: a `return` inside it belongs to a
    // function this walk is deliberately not entering.
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    collectReturnedObjects(value, into);
  }
}

/** The metadata object literals one `metadata` export declares, if any can be seen at all. */
function metadataObjectsOf(init: PageValueNode): PageObjectExpression[] {
  const value = unwrapValue(init);

  if (value.type === "ObjectExpression") return [value];

  if (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") {
    const body = unwrapValue(value.body as PageValueNode);

    // The concise arrow body — `({ data }) => ({ title: data.name })`, which is
    // how every function-form metadata export in the reference app is written.
    if (body.type === "ObjectExpression") return [body];

    const returned: PageObjectExpression[] = [];

    collectReturnedObjects(value.body, returned);

    return returned;
  }

  // `export const metadata = buildMetadata()`, or a bare identifier: the keys
  // are not in this file. Silent by design — see `collectUnknownKeys`.
  return [];
}

/**
 * The unknown keys a page's `metadata` export declares, read by PARSING — the
 * same rule the rest of this module lives by, and the reason this check can run
 * before anything is built.
 *
 * Empty for a page with no `metadata` export, for one whose metadata is a value
 * this file cannot see into, and for a correct one.
 */
export function readMetadataKeys(pageFile: string, source: string): UnknownMetadataKey[] {
  let program: ReturnType<typeof parse>["program"];

  try {
    program = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: false,
    }).program;
  } catch (error) {
    throw new Error(
      `Cannot read the \`metadata\` export of "${pageFile}": the file could not be parsed ` +
        `(${(error as Error).message}). Fix the syntax error and the build will continue.`,
    );
  }

  const unknownKeys: UnknownMetadataKey[] = [];

  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    const { declaration } = statement;

    if (declaration?.type !== "VariableDeclaration") continue;

    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.id.name !== "metadata") continue;
      if (declarator.init === null || declarator.init === undefined) continue;

      for (const object of metadataObjectsOf(declarator.init)) {
        collectUnknownKeys(object, METADATA_KEYS, "metadata", unknownKeys);
      }
    }
  }

  return unknownKeys;
}
