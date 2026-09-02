/**
 * Static discovery of the application's page graph — the ONE scan every
 * provider shares.
 *
 * This module has a single responsibility: look at the filesystem and produce
 * the recipe. It writes nothing, knows nothing about the generated barrel, and
 * imports neither Vite nor a single application module. Everything that turns
 * the recipe into an artefact (the production barrel, the dev plugin, the
 * generated client entry) lives with that artefact and consumes
 * {@link discoverPages}.
 *
 * The reason it is one module rather than one function per consumer: two
 * scanners that agree today drift tomorrow, and a page that exists for the
 * server but not the client is the silent failure that costs a day to find.
 * Sharing the scan makes that disagreement impossible by construction instead
 * of catchable by test.
 *
 * "Static" means WITHOUT RUNNING THE APPLICATION — this module globs
 * `*.page.tsx`, `layout.tsx` and `root.tsx`, and reads each page's declared
 * `route` and each layout's declared `prefix` by PARSING the source
 * ({@link readRouteExports}). It still imports no application module.
 *
 * An explicit `route` export wins. Otherwise the URL is derived from the page's
 * path beneath `src/web`: directories contribute segments, `(groups)` do not,
 * `index.page.tsx` claims its directory, and `[id]` becomes `:id`. A layout
 * `prefix` replaces its own directory segment. The same recipe is emitted to
 * every provider so build and boot cannot drift.
 *
 * Discovery also CLASSIFIES each layout — does its module have a default
 * export, does it export `middleware` — because the layout policy
 * ({@link "../routing/layout-policy.ts"}) owns the rule but may not touch a
 * filesystem to learn the facts the rule needs. That classification is another
 * parse, never an import: a layout is read exactly the way a page's `route` is.
 *
 * And it CHECKS the page's `metadata` keys ({@link UnknownMetadataKeyError}) —
 * see that error and {@link readMetadataKeys} for why a type alone does not
 * close that hole.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { composeRoutePath } from "../routing/compose-route-path";
// `../server/not-found-page` is imported for its CONSTANTS and its filename
// predicate only. Its sole runtime import is the default fallback's build-time
// stylesheet data URL; it imports no renderer or application runtime, so this
// edge cannot drag the render pipeline into the build. What a not-found page is,
// and what identity it carries, is decided in one place for discovery and both
// installers.
import {
  isNotFoundPageFile,
  NotFoundPageDeclaresRouteError,
  NOT_FOUND_ROUTE_NAME,
  NOT_FOUND_ROUTE_PATH,
} from "../server/not-found-page";
// The metadata key set, as VALUES. `../metadata` is a types-plus-constants
// module with no runtime imports of its own (both its imports are `import
// type`), so this costs the build nothing and buys the one thing a parse cannot
// get from a type: the list of keys a page is allowed to write.
import { METADATA_KEYS, OPEN_GRAPH_KEYS, TWITTER_KEYS } from "../metadata";
import { NestedLayoutsNotSupportedError, selectPageLayout } from "../routing/layout-policy";
import { deriveFilesystemRoutePath } from "../routing/filesystem-route";
import { canonicalizeRouteExport, resolvePageRouteName } from "../routing/route-identity";
import { assertPageHasDefaultExport } from "./page-default-export";
import type { RouteExportsReadResult } from "./read-route-exports";
import { NonLiteralRouteExportError, readRouteExports } from "./read-route-exports";

export type DiscoverPagesOptions = {
  /** Absolute path to the application root (where `package.json` lives). */
  appRoot: string;
  /** Source directory name under `appRoot`; defaults to `"src"`. */
  srcDir?: string;
};

export type DiscoveredRoutablePage = {
  /** A browsable page. Error pages are deliberately a different discovery kind. */
  type: "page";
  /**
   * The page's route name: the `name` its `route` export declares, or its
   * filesystem identity as dotted segments, with groups omitted.
   *
   * Unique across the whole graph — {@link discoverPages} refuses to return a
   * result where it is not.
   */
  routeName: string;
  /**
   * The page's effective route path. Explicit routes retain their existing
   * layout-prefix composition. Derived routes use filesystem segments, with
   * each declared layout prefix replacing that layout directory's segment.
   * Always `/`-prefixed.
   */
  routePath: string;
  /** Absolute path to the `*.page.tsx` file. */
  pageFile: string;
  /** The web root this page was found under — the root its layout chain climbs to. */
  webRoot: string;
  /** Absolute paths of every `layout.tsx` from the web root down to the page's own directory, OUTERMOST FIRST. */
  layouts: string[];
  /**
   * The page's middleware chain: the subset of {@link layouts} whose modules
   * export `middleware`, OUTERMOST FIRST — the order they must run in.
   *
   * Source files rather than the middleware values themselves, because
   * discovery never runs application code: this says WHICH layouts contribute a
   * guard, and the consumer that already loads those modules reads the values
   * off them.
   *
   * Empty when no layout on the path declares middleware, which is the common
   * case; a page with no layouts always has an empty chain.
   */
  middlewareLayouts: string[];
  /** Absolute path to the global `root.tsx` every page renders inside, when it exists. */
  appFile?: string;
};

/** The one application error boundary. It deliberately has no route identity. */
export type DiscoveredErrorPage = {
  type: "error";
  /** Absolute path to the sole `error.page.tsx` beneath `src/web`. */
  pageFile: string;
  webRoot: string;
  appFile?: string;
};

/** The complete static web graph: routable leaves plus the optional error boundary. */
export type DiscoveredPage = DiscoveredRoutablePage | DiscoveredErrorPage;

export function isDiscoveredRoutablePage(page: DiscoveredPage): page is DiscoveredRoutablePage {
  return page.type === "page";
}

export function isErrorPageFile(file: string): boolean {
  return path.basename(file) === "error.page.tsx";
}

export class DuplicateErrorPageError extends Error {
  public constructor(firstFile: string, secondFile: string) {
    super(
      `Two error pages were found: "${firstFile}" and "${secondFile}". An application may own exactly one \`error.page.tsx\` anywhere beneath src/web.`,
    );
    this.name = "DuplicateErrorPageError";
  }
}

export class ErrorPageDeclaresRouteError extends Error {
  public constructor(pageFile: string) {
    super(
      `The error page "${pageFile}" exports \`route\`. error.page.tsx is an error boundary, not a browsable page; remove the route export.`,
    );
    this.name = "ErrorPageDeclaresRouteError";
  }
}

/** Raised when two pages claim one route name. */
export class DuplicatePageRouteNameError extends Error {
  public constructor(
    public readonly routeName: string,
    public readonly firstFile: string,
    public readonly secondFile: string,
  ) {
    super(
      `Two pages resolve to the same route name "${routeName}": "${firstFile}" and ` +
        `"${secondFile}". A route name identifies exactly one page, so the second ` +
        "page would be unreachable. To fix: rename one of the files, or move it so " +
        "its directory gives it a different route name.",
    );
    this.name = "DuplicatePageRouteNameError";
  }
}

/** Raised when two different page files resolve to one effective URL. */
export class DuplicatePageRoutePathError extends Error {
  public constructor(
    public readonly routePath: string,
    public readonly firstFile: string,
    public readonly secondFile: string,
  ) {
    super(
      `Two pages resolve to the same route path "${routePath}": "${firstFile}" and ` +
        `"${secondFile}". Each URL may identify exactly one page. Rename or move one file, ` +
        "or give one page an explicit route with a different path.",
    );
    this.name = "DuplicatePageRoutePathError";
  }
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The page root. It is optional; a project without it has zero pages, which is
 * a legal empty state.
 */
export function discoverWebRoots(srcRoot: string): string[] {
  const webRoot = path.join(srcRoot, "web");

  return isDirectory(webRoot) ? [webRoot] : [];
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export type DiscoveredPageFile = {
  /** Absolute path to the `*.page.tsx` file. */
  pageFile: string;
  /** The web root ({@link discoverWebRoots}) this page was found under. */
  webRoot: string;
};

/**
 * The subject list: every `*.page.tsx` under the page root, one call for the
 * whole graph.
 *
 * Unlike {@link discoverPages}, this reads no `route` or `prefix` export and
 * throws on nothing — it answers only "which page files exist", so a provider
 * that still resolves a page's route by its own means (dev's
 * `ssrLoadModule`-driven installer, chiefly) can share the walk without
 * inheriting the static-parsing refusals that answering "what route is this"
 * requires.
 */
export function discoverPageFiles(srcRoot: string): DiscoveredPageFile[] {
  const found: DiscoveredPageFile[] = [];

  for (const webRoot of discoverWebRoots(srcRoot)) {
    for (const pageFile of walkFiles(webRoot, (fileName) => fileName.endsWith(".page.tsx"))) {
      found.push({ pageFile, webRoot });
    }
  }

  return found;
}

/** Every file under `dir` (recursive) whose name matches `predicate`. */
export function walkFiles(dir: string, predicate: (fileName: string) => boolean): string[] {
  const found: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      found.push(full);
    }
  }

  return found;
}

/**
 * A page's layout chain: every `layout.tsx` in the directories from its web
 * root down to its own directory, OUTERMOST FIRST.
 *
 * Dev's installer reads only the nearest layout today, because its page module
 * triple holds a single layout; the recipe carries the whole chain so the
 * runtime side can compose
 * nested layouts without a second discovery pass. The nearest layout is always
 * the LAST element, so a consumer that still wants dev's one-layout behaviour
 * reads `layouts.at(-1)`.
 */
export function layoutChainFor(pageFile: string, webRoot: string): string[] {
  const chain: string[] = [];
  const relativeDir = path.relative(webRoot, path.dirname(pageFile));
  const segments = relativeDir === "" ? [] : relativeDir.split(path.sep);

  let current = webRoot;

  for (let index = 0; index <= segments.length; index++) {
    if (index > 0) {
      current = path.join(current, segments[index - 1]);
    }

    const candidate = path.join(current, "layout.tsx");

    if (isFile(candidate)) {
      chain.push(candidate);
    }
  }

  return chain;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The total order every consumer sees, and the reason discovery returns an
 * array rather than a set: the page's SOURCE FILE PATH, lexicographic, POSIX.
 *
 * Serialization order only; matching precedence is a property of the route
 * grammar, not of this array.
 *
 * The file path rather than the route path, now that the route is the declared
 * one: a page's route can be rewritten by editing one line, which would reorder
 * an artefact that has not otherwise changed, while the file it lives in is the
 * stable identity the artefact is built from. It also carries no suggestion of
 * precedence — nobody reads "sorted by file name" as "most specific first",
 * which is the misreading a route-path order invites.
 *
 * Lexicographic because it is byte-comparable output across every provider,
 * which keeps diffs stable and keeps filesystem enumeration order out of the
 * artefact: two machines that list a directory differently must still produce
 * byte-identical output, or a build is only reproducible by luck.
 */
function comparePages(left: DiscoveredPage, right: DiscoveredPage): number {
  return compareStrings(toPosix(left.pageFile), toPosix(right.pageFile));
}

function assertUniqueRouteNames(pages: readonly DiscoveredRoutablePage[], appRoot: string): void {
  const fileByRouteName = new Map<string, string>();

  for (const page of pages) {
    const existing = fileByRouteName.get(page.routeName);
    const relative = toPosix(path.relative(appRoot, page.pageFile));

    if (existing !== undefined) {
      throw new DuplicatePageRouteNameError(page.routeName, existing, relative);
    }

    fileByRouteName.set(page.routeName, relative);
  }
}

/**
 * A page's declared `route.path` is a choice its author made deliberately, so
 * two pages that both declare the same path are the author's call, not an
 * accident — {@link assertUniqueRouteNames} is what keeps each of them
 * reachable by name. What this refuses is a COLLISION NOBODY CHOSE: at least
 * one side's path is filesystem-derived, which is exactly the case a rename
 * or a new file can produce without anyone noticing two pages now answer the
 * same URL. The reserved not-found path (`"*"`) is never a candidate here
 * either way — it identifies no browsable URL, and {@link assertUniqueRouteNames}
 * already refuses a second `404.page.tsx` by its own reserved name.
 */
function assertUniqueRoutePaths(
  pages: readonly DiscoveredRoutablePage[],
  appRoot: string,
  explicitFiles: ReadonlySet<string>,
): void {
  const fileByRoutePath = new Map<string, string>();

  for (const page of pages) {
    if (page.routePath === NOT_FOUND_ROUTE_PATH) continue;

    const existing = fileByRoutePath.get(page.routePath);
    const relative = toPosix(path.relative(appRoot, page.pageFile));

    if (existing !== undefined && !(explicitFiles.has(existing) && explicitFiles.has(relative))) {
      throw new DuplicatePageRoutePathError(page.routePath, existing, relative);
    }

    if (existing === undefined) fileByRoutePath.set(page.routePath, relative);
  }
}

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

/**
 * The declared exports of one file, or a thrown
 * {@link NonLiteralRouteExportError} when they cannot be read without running
 * the application. Layouts are read once per run and remembered: a layout is
 * the nearest one for every page beside it, and parsing it once per page would
 * be the same answer bought repeatedly.
 *
 * `source` is the file's text when the caller already holds it — the page loop
 * reads each page once and spends that read on both the route declarations and
 * the metadata check, rather than opening the same file twice.
 */
function readDeclarations(
  sourceFile: string,
  cache: Map<string, RouteExportsReadResult>,
  source?: string,
) {
  let result = cache.get(sourceFile);

  if (result === undefined) {
    result = readRouteExports(sourceFile, source);
    cache.set(sourceFile, result);
  }

  if (!result.ok) {
    throw new NonLiteralRouteExportError(result.rejection);
  }

  return result;
}

/**
 * What a layout DOES, read by parsing it — the facts the layout policy's rule
 * needs and, being a pure module, cannot go and find for itself.
 */
type LayoutShape = {
  /**
   * Whether the module has a default export — the export that puts an element
   * in the document, and therefore the one thing that makes a layout count
   * against the single-rendering-layout rule.
   */
  renders: boolean;
  /** Whether the module exports `middleware`, or might via a re-export this cannot see through. */
  hasMiddleware: boolean;
};

/**
 * Parses one layout and reports its shape. Remembered per run for the same
 * reason declarations are: a layout is on the path of every page beneath it.
 */
function readLayoutShape(layoutFile: string, cache: Map<string, LayoutShape>): LayoutShape {
  const cached = cache.get(layoutFile);

  if (cached !== undefined) return cached;

  const source = fs.readFileSync(layoutFile, "utf-8");
  let program: ReturnType<typeof parse>["program"];

  try {
    program = parse(source, {
      sourceType: "module",
      // Every file this reads is a layout, i.e. `.tsx`.
      plugins: ["typescript", "jsx"],
      errorRecovery: false,
    }).program;
  } catch (error) {
    throw new Error(
      `Cannot read the exports of "${layoutFile}": the file could not be parsed ` +
        `(${(error as Error).message}). Fix the syntax error and the build will continue.`,
    );
  }

  const shape: LayoutShape = { renders: false, hasMiddleware: false };

  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      shape.renders = true;
      continue;
    }

    // `export * from "./guard"` cannot re-export a default — the language
    // excludes it — but it CAN contribute `middleware`, and no parse can see
    // through it without resolving and reading another module. Reading it as
    // "no middleware here" is exactly the silent unguarding this slice exists
    // to prevent, so it is read as "possibly" and fails loudly downstream.
    if (statement.type === "ExportAllDeclaration") {
      shape.hasMiddleware = true;
      continue;
    }

    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;

      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : specifier.exported.value;

      if (exported === "default") shape.renders = true;
      if (exported === "middleware") shape.hasMiddleware = true;
    }

    const { declaration } = statement;

    if (declaration === null || declaration === undefined) continue;

    if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && declarator.id.name === "middleware") {
          shape.hasMiddleware = true;
        }
      }

      continue;
    }

    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id?.name === "middleware"
    ) {
      shape.hasMiddleware = true;
    }
  }

  cache.set(layoutFile, shape);

  return shape;
}

/**
 * Scans the page root and returns the pages in a defined total order.
 *
 * Zero pages is a legal result, not an error: a project may be configured
 * with web and have nothing to serve yet. What is an error is a `*.page.tsx`
 * with a route or metadata export that cannot be read statically; two pages
 * claiming one effective path or route name, which this refuses
 * to return at all — the alternative is an artefact in which one of them is
 * silently unreachable; a `route` or `prefix` that cannot be read without
 * running the application, which is refused before any page is reported at
 * all; a `metadata` export declaring a key nothing reads, which no compiler
 * catches unless the page opted into the type and which otherwise serves a page
 * with a silently missing tag; and a page whose layout chain holds more than one RENDERING layout, which
 * the production installer would refuse anyway — discovery refuses it first so
 * that artefact is never produced.
 */
export function discoverPages(options: DiscoverPagesOptions): DiscoveredPage[] {
  const { appRoot } = options;
  const srcRoot = path.join(appRoot, options.srcDir ?? "src");
  const webRoots = discoverWebRoots(srcRoot);
  const appFile = path.join(srcRoot, "web", "root.tsx");
  const hasAppFile = isFile(appFile);
  const declarations = new Map<string, RouteExportsReadResult>();
  const layoutShapes = new Map<string, LayoutShape>();
  const relativeToApp = (file: string) => toPosix(path.relative(appRoot, file));

  const pages: DiscoveredPage[] = [];
  const explicitRouteFiles = new Set<string>();
  let errorPage: DiscoveredErrorPage | undefined;

  for (const webRoot of webRoots) {
    for (const pageFile of walkFiles(webRoot, (fileName) => fileName.endsWith(".page.tsx"))) {
      const pageSource = fs.readFileSync(pageFile, "utf-8");
      assertPageHasDefaultExport(relativeToApp(pageFile), pageSource);
      const { route } = readDeclarations(pageFile, declarations, pageSource);
      if (isErrorPageFile(pageFile)) {
        if (route !== undefined) throw new ErrorPageDeclaresRouteError(relativeToApp(pageFile));

        if (errorPage !== undefined) {
          throw new DuplicateErrorPageError(
            relativeToApp(errorPage.pageFile),
            relativeToApp(pageFile),
          );
        }

        errorPage = { type: "error", pageFile, webRoot, ...(hasAppFile ? { appFile } : {}) };
        continue;
      }
      const isNotFoundPage = isNotFoundPageFile(pageFile);

      // THE NOT-FOUND PAGE IS THE ONE PAGE WITH NO URL, in both directions.
      //
      // Every ordinary page may derive its URL from the filesystem.
      // `404.page.tsx` is reached by NOT matching, so the opposite remains the
      // error: a `route` export here reads as a promise that some path is
      // browsable, which the installers never keep.
      //
      // Discovery still reports it, with the SAME reserved identity both
      // installers register it under, so the emitted artefacts agree with the
      // server about which entry is the not-found page — and so the client
      // registry carries the module the SSR'd document has to hydrate against.
      if (isNotFoundPage && route !== undefined) {
        throw new NotFoundPageDeclaresRouteError(relativeToApp(pageFile));
      }

      // The page contract is not only `route`. `metadata` is the other export
      // every page may declare, and it is the one with no compiler behind it
      // unless the author opted in to a type annotation — so it is checked
      // here, by name, exactly like the route above.
      //
      // AFTER the reserved-404 route check on purpose: an impossible 404 route
      // contract is more fundamental than a malformed `<head>` declaration.
      const unknownMetadataKeys = readMetadataKeys(relativeToApp(pageFile), pageSource);

      if (unknownMetadataKeys.length > 0) {
        throw new UnknownMetadataKeyError(relativeToApp(pageFile), unknownMetadataKeys);
      }

      // The policy decides which layout the page RENDERS INSIDE, from the FULL
      // enumerated chain: a layout anywhere on the ancestry path counts, not
      // just one in the page's own directory. Discovery supplies the one fact
      // the rule needs and the pure policy cannot learn — whether each layout
      // renders anything at all.
      const layouts = layoutChainFor(pageFile, webRoot);
      const shapes = layouts.map((layoutFile) => readLayoutShape(layoutFile, layoutShapes));
      const selection = selectPageLayout(
        layouts.map((layout, index) => ({ layout, renders: shapes[index].renders })),
      );

      if (selection.type === "rejected") {
        throw new NestedLayoutsNotSupportedError(
          relativeToApp(pageFile),
          selection.layouts.map(relativeToApp),
        );
      }

      // Every layout that declares a guard, outermost first. Both installers
      // now CONCATENATE the whole chain into the pipeline's single layout slot
      // (`../server/install-page-routes.ts`, `../server/install-page-routes-from-manifest.ts`),
      // so a guard anywhere on the path runs, in this order — which is why the
      // temporary refusal that used to stand here is gone rather than relaxed.
      const middlewareLayouts = layouts.filter((_, index) => shapes[index].hasMiddleware);

      // EVERY prefix on the path, outermost first: a `prefix`-only layout is
      // still a segment of the URL, and composing only the rendering layout's
      // would serve the subtree from a path nobody declared.
      const layoutPrefix = layouts.reduce(
        (composed, layoutFile) =>
          composeRoutePath(composed, readDeclarations(layoutFile, declarations).prefix ?? "/"),
        "/",
      );

      const relativePageFile = toPosix(path.relative(webRoot, pageFile));
      const layoutPrefixes = Object.fromEntries(
        layouts.flatMap((layoutFile) => {
          const prefix = readDeclarations(layoutFile, declarations).prefix;
          if (prefix === undefined) return [];

          const directory = toPosix(path.relative(webRoot, path.dirname(layoutFile)));
          return [[directory, prefix]];
        }),
      );
      // Routed through `canonicalizeRouteExport` — the ONE seam that validates
      // a declared `route.path` (`../routing/route-identity.ts`) — rather than
      // reading `route.path` directly, so `effectiveRoutePath` can never carry
      // a path the grammar has rejected. This does not depend on `routeName`
      // (below) also validating: even if that field were reordered, made
      // conditional, or removed, an unsupported declared path still cannot
      // reach `effectiveRoutePath` unvalidated.
      const canonicalRoute =
        !isNotFoundPage && route ? canonicalizeRouteExport(route, relativePageFile) : undefined;

      const effectiveRoutePath = isNotFoundPage
        ? NOT_FOUND_ROUTE_PATH
        : canonicalRoute
          ? composeRoutePath(layoutPrefix, canonicalRoute.path)
          : deriveFilesystemRoutePath({ pageFile: relativePageFile, layoutPrefixes });

      if (!isNotFoundPage && route !== undefined) {
        explicitRouteFiles.add(relativeToApp(pageFile));
      }

      pages.push({
        type: "page",
        routeName: isNotFoundPage
          ? NOT_FOUND_ROUTE_NAME
          : resolvePageRouteName(route, relativePageFile),
        // The catch-all, which the client route matcher already understands as
        // a terminal `catch-all` token sorted LAST by specificity
        // (`../client/runtime/matcher.ts`) — so the browser resolves the
        // not-found page for a URL that matched nothing, exactly as the server
        // did, and never in preference to a real page.
        routePath: effectiveRoutePath,
        pageFile,
        webRoot,
        // THE NOT-FOUND PAGE RENDERS INSIDE THE APPLICATION ROOT AND NOTHING
        // ELSE — an EMPTY chain, not the one enumerated above.
        //
        // Both installers render it with `layoutFile: undefined`, deliberately
        // and independently (`../server/install-page-routes.ts`,
        // `../server/install-page-routes-from-manifest.ts`), for the same
        // reason the 404 page takes no loader: a path whose entire job is to
        // handle failure must not depend on chrome that can itself throw,
        // redirect, or need data. Reporting layouts here anyway put them in the
        // client registry and therefore in HYDRATION, so the server rendered
        // `App(Page)` while the browser rebuilt `App(Layout(Page))` — a
        // guaranteed mismatch on the one route nobody is watching, invisible to
        // any application that happens to have no layouts.
        //
        // Aligned by REMOVING them from the client, never by giving them to the
        // server: layouts on the not-found route would make it the most fragile
        // route in the application.
        //
        // The chain above is still enumerated and still validated, so a nested
        // layout on this page's path is refused at build time exactly as it is
        // everywhere else — what changes is only what the page renders inside.
        layouts: isNotFoundPage ? [] : layouts,
        middlewareLayouts: isNotFoundPage ? [] : middlewareLayouts,
        ...(hasAppFile ? { appFile } : {}),
      });
    }
  }

  // The error page is captured separately above so a second one can be
  // compared against the first before either is trusted — it joins the
  // returned graph here, once discovery knows there is exactly one.
  if (errorPage !== undefined) pages.push(errorPage);

  pages.sort(comparePages);

  const routablePages = pages.filter(isDiscoveredRoutablePage);
  assertUniqueRoutePaths(routablePages, appRoot, explicitRouteFiles);
  assertUniqueRouteNames(routablePages, appRoot);

  return pages;
}
