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
 * The route a page is served under is the one the page DECLARES, not the one
 * its directory suggests, so that is the route discovery reports. The
 * composition — EVERY layout `prefix` on the page's path, outermost first, plus
 * the page's own `route` path — and the fallback used when a route omits its
 * name are mirrored from the server's installer (`installPageRoutes`),
 * deliberately and in one direction: build and boot agree because one of them
 * copies the other, not because two conventions were written to match.
 *
 * Discovery also CLASSIFIES each layout — does its module have a default
 * export, does it export `middleware` — because the layout policy
 * ({@link "../routing/layout-policy.ts"}) owns the rule but may not touch a
 * filesystem to learn the facts the rule needs. That classification is another
 * parse, never an import: a layout is read exactly the way a page's `route` is.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { composeRoutePath } from "../routing/compose-route-path";
import { NestedLayoutsNotSupportedError, selectPageLayout } from "../routing/layout-policy";
import { deriveFallbackRouteName } from "../routing/route-identity";
import type { RouteExportsReadResult } from "./read-route-exports";
import { NonLiteralRouteExportError, readRouteExports } from "./read-route-exports";

export type DiscoverPagesOptions = {
  /** Absolute path to the application root (where `package.json` lives). */
  appRoot: string;
  /** Source directory name under `appRoot`; defaults to `"src"`. */
  srcDir?: string;
};

export type DiscoveredPage = {
  /**
   * The page's route name: the `name` its `route` export declares, or the
   * server's own fallback derivation — `<module>.<declared path with dots>` for
   * a page in a module's web tree, the dotted path alone for one in the global
   * tree, and `index` when neither has anything to say.
   *
   * Unique across the whole graph — {@link discoverPages} refuses to return a
   * result where it is not.
   */
  routeName: string;
  /**
   * The page's EFFECTIVE route path: the declared `prefix` of EVERY layout on
   * its path — outermost first, wherever in the ancestry each lives — composed
   * in order with the page's own declared `route` path, which is the path the
   * server registers it under. A layout that declares no `prefix` contributes
   * nothing. Always `/`-prefixed.
   *
   * Every layout, not just the rendering one: a `prefix`-only layout is a real
   * segment of the URL its subtree lives under, and skipping it would serve the
   * subtree from a path nobody wrote down.
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
 * The two page roots: the global `src/web/**` tree and each
 * module's `src/app/<module>/web/**` tree. Both are optional; a project with
 * neither has zero pages, which is a legal empty state.
 */
export function discoverWebRoots(srcRoot: string): string[] {
  const roots: string[] = [];
  const globalRoot = path.join(srcRoot, "web");

  if (isDirectory(globalRoot)) {
    roots.push(globalRoot);
  }

  const appDir = path.join(srcRoot, "app");

  if (isDirectory(appDir)) {
    for (const entry of fs.readdirSync(appDir, { withFileTypes: true }).sort(byName)) {
      if (!entry.isDirectory()) continue;

      const moduleWebRoot = path.join(appDir, entry.name, "web");

      if (isDirectory(moduleWebRoot)) {
        roots.push(moduleWebRoot);
      }
    }
  }

  return roots;
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
 * The subject list: every `*.page.tsx` under BOTH web roots, one call for the
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

function assertUniqueRouteNames(pages: readonly DiscoveredPage[], appRoot: string): void {
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

/** Raised when a `*.page.tsx` declares no `route` export. */
export class MissingRouteExportError extends Error {
  public constructor(public readonly pageFile: string) {
    super(
      `"${pageFile}" is a page file but declares no \`route\` export. A page with no route is a ` +
        "page the dev server would still serve and production would 404 on, so the build refuses " +
        `it instead. For example: export const route = "/list";`,
    );
    this.name = "MissingRouteExportError";
  }
}

/**
 * The declared exports of one file, or a thrown
 * {@link NonLiteralRouteExportError} when they cannot be read without running
 * the application. Layouts are read once per run and remembered: a layout is
 * the nearest one for every page beside it, and parsing it once per page would
 * be the same answer bought repeatedly.
 */
function readDeclarations(sourceFile: string, cache: Map<string, RouteExportsReadResult>) {
  let result = cache.get(sourceFile);

  if (result === undefined) {
    result = readRouteExports(sourceFile);
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
 * Scans both web roots and returns the pages in a defined total order.
 *
 * Zero pages is a legal result, not an error: a project may be configured
 * with web and have nothing to serve yet. What is an error is a `*.page.tsx`
 * with no `route` export, which is refused rather than silently omitted — an
 * artefact that leaves a page out is a page the dev server still serves and
 * production 404s on; two pages claiming one route name, which this refuses
 * to return at all — the alternative is an artefact in which one of them is
 * silently unreachable; a `route` or `prefix` that cannot be read without
 * running the application, which is refused before any page is reported at
 * all; and a page whose layout chain holds more than one RENDERING layout, which
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

  for (const webRoot of webRoots) {
    for (const pageFile of walkFiles(webRoot, (fileName) => fileName.endsWith(".page.tsx"))) {
      const { route } = readDeclarations(pageFile, declarations);

      if (route === undefined) {
        throw new MissingRouteExportError(relativeToApp(pageFile));
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

      pages.push({
        routeName:
          route.name ??
          deriveFallbackRouteName({
            routePath: route.path,
            sourceFile: relativeToApp(pageFile),
          }),
        routePath: composeRoutePath(layoutPrefix, route.path),
        pageFile,
        webRoot,
        layouts,
        middlewareLayouts,
        ...(hasAppFile ? { appFile } : {}),
      });
    }
  }

  pages.sort(comparePages);

  assertUniqueRouteNames(pages, appRoot);

  return pages;
}
