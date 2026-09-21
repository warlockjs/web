/**
 * Registers every page {@link discoverPageFiles} finds under `<appSrcRoot>`
 * into Warlock's router (`router.get`, `core/src/router/router.ts:359-361`)
 * so `router.scanDevServer(fastify)` —
 * the sanctioned dev-server dispatch path (server matching is Warlock's
 * router; there is no second server matcher) — picks
 * it up. Replaces the two hand-rolled `fastify.get()` calls this file's
 * sibling, `dev-error-transport.ts`, used to make directly.
 *
 * DELIBERATE EXCEPTION to "web has no core dependency", same
 * reasoning `dev-error-transport.ts`'s own header comment records: this module is not
 * exported from either package barrel and is not part of `web/package.json`'s
 * dependency graph — dev/CLI bootstrap only.
 *
 * Scope note: a page's
 * `route.path` is now composed with the `prefix` export of EVERY `layout.tsx`
 * on its path — outermost first (`composeRoutePath` below) — before
 * registration and before the collision check, so `home.page.tsx`
 * (`path: "/"`, main layout `prefix: "/"`) resolves to `/` and
 * `products.page.tsx` (`path: "/"`, products layout `prefix: "/products"`)
 * resolves to `/products` — no collision. A page with no `layout.tsx` on its
 * path composes against the implicit root prefix `"/"` (e.g. `/contact-us`,
 * `/hydration-demo`, both unaffected by composition).
 *
 * WHICH PAGES EXIST is answered by {@link discoverPageFiles}
 * (`web/src/build/discover-pages.ts`) — the same walk production's build
 * shares — so this file owns no directory-walking of its own; it serves the
 * page root (`<appSrcRoot>/web/**`) exactly as discovery enumerates it. WHAT
 * ROUTE A PAGE ANSWERS ON stays this file's own job: each page and its nearest layout are still evaluated
 * through Vite (`vite.ssrLoadModule`), never read statically, because a dev
 * page module must be the one Vite serves, warm cache and all.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import type { ViteDevServer } from "vite";
import {
  discoverPageFileGraph,
  type DiscoveredPageFileGraph,
  ErrorPageDeclaresRouteError,
  isErrorPageFile,
  layoutChainFor,
} from "../build/discover-pages";
import { readModuleConfig } from "../build/read-module-config";
import { composeRoutePath } from "../routing/compose-route-path";
import { duplicateRoutePathMessage } from "../routing/duplicate-route-path";
import { deriveFilesystemRoutePath } from "../routing/filesystem-route";
import { resolveLayoutLevel as resolveComposedLayoutLevel } from "../routing/layout-level";
import { PageFileSegmentNotSupportedError } from "../routing/page-file-segment";
import { toPosix } from "../shared/to-posix";
import { resolvePageRouteIdentity, resolvePageRouteName } from "../routing/route-identity";
import { prepareRouteTable } from "../routing/route-table";
import { publishLocaleRouting } from "../routing/locale-routing";
import { config, type FastifyInstance, type Router } from "@warlock.js/core";
import {
  buildRouteLocaleManifest,
  type RouteLocaleManifest,
} from "../build/build-route-locale-manifest";
import { prepareDevRouteLocaleArtifact } from "./dev-route-locale-artifact";
import { composeLayoutModules } from "./compose-layout-modules";
import { createPageRouteHandler, type PageRouteHandler } from "./create-page-route-handler";
import { resolveLocaleRouting } from "./locale-routing/resolve-locale-routing";
import { localePageRegistrations } from "./locale-routing/locale-page-registrations";
import type { ErrorPageModule } from "./error-page";
import { layoutPrefixesByDirectory } from "./layout-prefixes";
import { notFoundPageHandlerOptions } from "./not-found-handler-options";
import { normalizePageModule } from "./normalize-page-module";
import { devDeclaredStylesheetUrls, devHandlerStylesheetUrls } from "./stylesheet-urls";
import type { RequestStylesheetUrlResolver } from "./document-stylesheet-urls";
import {
  DuplicateNotFoundPageError,
  isNotFoundPageFile,
  NotFoundPageDeclaresRouteError,
  registerNotFoundPageRoute,
} from "./not-found-page";
import type { LayoutModuleShape, PageRouteExport } from "./page-module-shapes";
import { createRouteTranslationsResolver } from "./route-translations";

export type { LayoutModuleShape, PageModuleShape, PageRouteExport } from "./page-module-shapes";

/** Re-exported so `web/src/server/index.ts`'s existing barrel export keeps resolving. */
export { composeRoutePath };

/** Raised at boot when a page still uses the withdrawn `route.middleware` export. */
export class RouteMiddlewareRemovedError extends Error {
  public constructor(public readonly pageFile: string) {
    super(
      `"${pageFile}" declares \`route.middleware\`, which no longer runs — it was withdrawn after 5.6.0. ` +
        "Move it to the page's own top-level `middleware` export instead: `export const middleware = [...]`.",
    );
    this.name = "RouteMiddlewareRemovedError";
  }
}

/** Raised at boot when a page still uses the withdrawn `route.validate` export. */
export class RouteValidationRemovedError extends Error {
  public constructor(public readonly pageFile: string) {
    super(
      `"${pageFile}" declares \`route.validate\`, which no longer runs — it was withdrawn after 5.6.0. ` +
        "Move it to the page's top-level `validation` export instead: `export const validation = { params: ..., query: ... }`.",
    );
    this.name = "RouteValidationRemovedError";
  }
}

export type InstalledPageRoute = {
  /** The canonical declared route path, before layout-prefix composition. */
  declaredPath: string;
  path: string;
  name: string;
  file: string;
  layoutFile: string | undefined;
};

/**
 * Ownership key for the framework's fallback 404 route. A NUL-prefixed value
 * cannot be a real filesystem path, so it cannot collide with an app page's
 * canonical source-file key.
 */
export const FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE = "\0warlock:framework-default-404";

/**
 * The page's application-source-relative POSIX source path used as the router's
 * stable ownership key. `appSrcRoot`'s own basename preserves the existing
 * `src/web/...` source-file convention.
 */
function canonicalSourceFileFor(pageFile: string, appSrcRoot: string): string {
  return `${path.basename(appSrcRoot)}/${toPosix(path.relative(appSrcRoot, pageFile))}`;
}

export function filesystemPageFileFor(pageFile: string, appSrcRoot: string): string {
  return toPosix(path.relative(path.join(appSrcRoot, "web"), pageFile));
}

/**
 * Raised when a page's own module fails to load in dev (`vite.ssrLoadModule`
 * rejects on the page file itself — never a layout, which this class does not
 * cover).
 *
 * Before this class existed, that rejection propagated straight out of
 * `installPageRoutes`'s loop and failed the WHOLE install: every other page's
 * route went unregistered along with the broken one, and the failure named
 * neither the page file nor which module actually threw. One bad page taking
 * every other page down with it is a worse outage than the bad page alone, so
 * this error is what the broken page's own route now fails with instead —
 * named, with its cause attached, while the rest of the application keeps
 * serving.
 */
export class PageModuleLoadError extends Error {
  public constructor(
    public readonly pageFile: string,
    cause: unknown,
  ) {
    const rawCause = cause instanceof Error ? cause.message : String(cause);
    // The cause is someone else's text — a bundler's, a module resolver's — so
    // it may or may not end in punctuation. Without this it runs straight into
    // the next sentence, and the seam is exactly where a reader stops trusting
    // the message.
    const causeMessage = /[.!?]$/.test(rawCause.trim()) ? rawCause.trim() : `${rawCause.trim()}.`;

    super(
      `"${pageFile}" failed to load: ${causeMessage} Every other page still installed and is ` +
        "still serving; fix the error in this page's module and it will start serving again.",
      { cause },
    );
    this.name = "PageModuleLoadError";
  }
}

/**
 * Registers a page whose OWN module failed to load at its filesystem-derived
 * URL, so a request there reports {@link PageModuleLoadError} — naming the
 * page file and the underlying cause — instead of a bare 404 that explains
 * nothing.
 *
 * Only the filesystem-derived path is attempted: the page's `route` export
 * cannot be read (that requires the very module that failed to load), and its
 * layout chain is not resolved either, so no layout prefix composes into this
 * path. When the filesystem path itself is not derivable
 * (`deriveFilesystemRoutePath` rejects a segment), there is no path left to
 * register a route at, so nothing is registered — the caller reports both
 * failures loudly at boot and moves on.
 */
async function registerFailedPageRoute(input: {
  router: Router;
  pageFile: string;
  appSrcRoot: string;
  loadError: unknown;
  fileByPath: Map<string, string>;
}): Promise<void> {
  const { router, pageFile, appSrcRoot, loadError, fileByPath } = input;
  const attributed = new PageModuleLoadError(pageFile, loadError);
  const filesystemPageFile = filesystemPageFileFor(pageFile, appSrcRoot);

  let effectivePath: string;

  try {
    effectivePath = deriveFilesystemRoutePath({ pageFile: filesystemPageFile });
  } catch (segmentError) {
    if (!(segmentError instanceof PageFileSegmentNotSupportedError)) throw segmentError;

    // No filesystem path to register a route at, so this page cannot answer
    // its own URL with the attributed error — the request that would have hit
    // it 404s instead, unregistered, and the existing unregistered-page
    // reporter (`web/src/server/unregistered-pages.ts`) is what explains that
    // 404 to whoever is looking. Reported loudly here so the underlying load
    // failure is not lost as well.
    console.error(attributed.message);
    console.error(segmentError.message);

    return;
  }

  const existingFile = fileByPath.get(effectivePath);

  if (existingFile) {
    throw new Error(duplicateRoutePathMessage({ effectivePath, existingFile, newFile: pageFile }));
  }

  fileByPath.set(effectivePath, pageFile);

  await router.withSourceFile(canonicalSourceFileFor(pageFile, appSrcRoot), () =>
    router.get(
      effectivePath,
      async () => {
        throw attributed;
      },
      { name: resolvePageRouteName(undefined, filesystemPageFile), isPage: true },
    ),
  );
}

/** How this module gets a layout module namespace — `vite.ssrLoadModule`, in practice. */
type LoadLayout = (layoutFile: string) => Promise<LayoutModuleShape>;

/**
 * The page's layout LEVEL, resolved from its whole chain rather than from the
 * one layout nearest to it.
 *
 * The render pipeline has exactly one layout slot per page
 * (`execute-page-request.ts`'s `PageRouteEntry["triple"]`), so the chain has to
 * be collapsed into one module before it reaches a handler. Two things collapse
 * differently and both matter:
 *
 * - RENDERING is a selection: at most one layout on the chain may render, and
 *   the policy picks it. `renders` is read off the loaded module
 *   (`typeof module.default !== "undefined"`), never off the filename — a
 *   `middleware`-only layout has no default export and is not a wrapper, and
 *   passing a bare path to the policy would have it read as a rendering one,
 *   which is the conservative default and the wrong answer here.
 * - MIDDLEWARE and PREFIX are compositions: every layout on the path
 *   contributes, outermost first. A guard on an outer layout that the page's
 *   own directory knows nothing about is exactly the guard that must still run,
 *   and a prefix nobody composed is a URL nobody wrote down.
 *
 * The selection and prefix composition rules themselves do not depend on
 * where a layout's module came from, so they are not re-derived here — see
 * `../routing/layout-level.ts`'s `resolveLayoutLevel`, which production's
 * installer calls against the same rules. This function's own job is
 * everything that DOES depend on the source: walking the chain
 * (`layoutChainFor`), loading each module (`loadLayout`) and keying declared
 * prefixes by filesystem directory for {@link deriveFilesystemRoutePath}.
 */
type LayoutLevel = {
  /** Every `layout.tsx` from the web root down to the page's directory, outermost first. */
  chain: string[];
  /**
   * The module id the handler's layout slot is registered under, or `undefined`
   * when the page has no layout at all: the layout that RENDERS, or — when none
   * does — the nearest one, which is the slot dev has always used and so the
   * choice that changes nothing but the middleware for a chain with no wrapper
   * in it.
   */
  layoutFile: string | undefined;
  /** Every layout's `prefix`, composed outermost first — `discoverPages`' own reduction. */
  prefix: string;
  /** Declared prefixes keyed by layout directory relative to this page's web root. */
  prefixesByDirectory: Readonly<Record<string, string>>;
};

async function resolveLayoutLevel(
  pageFile: string,
  webRoot: string,
  loadLayout: LoadLayout,
): Promise<LayoutLevel> {
  const chain = layoutChainFor(pageFile, webRoot);
  const pairs = await Promise.all(
    chain.map(async (layoutFile) => ({ layoutFile, module: await loadLayout(layoutFile) })),
  );
  const level = resolveComposedLayoutLevel(
    pageFile,
    pairs.map(({ layoutFile, module }) => ({
      id: layoutFile,
      renders: typeof module.default !== "undefined",
      prefix: module.prefix,
    })),
  );

  return {
    chain,
    layoutFile: level.hostId,
    prefix: level.prefix,
    prefixesByDirectory: layoutPrefixesByDirectory(
      pairs.map(({ layoutFile, module }) => ({
        directory: toPosix(path.relative(webRoot, path.dirname(layoutFile))),
        prefix: module.prefix,
      })),
    ),
  };
}

/**
 * The layout slot's module for ONE request: the slot host's own namespace, with
 * the whole chain's middleware in place of its own — outermost first, which is
 * the order stage 3 runs the array in (`execute-page-request.ts:519-524`) and
 * the order an outer `optionalAuth` needs in order to have resolved an identity
 * before an inner `gate()` checks it.
 *
 * Loaded per call, not once at install time: a dev layout module must be the
 * one Vite is currently serving, edits and all.
 */
async function composeLayoutLevel(
  level: LayoutLevel & { layoutFile: string },
  loadLayout: LoadLayout,
): Promise<LayoutModuleShape> {
  const modules = await Promise.all(level.chain.map(loadLayout));
  const hostIndex = level.chain.indexOf(level.layoutFile);

  return composeLayoutModules(modules, hostIndex, level.chain);
}

export type InstallPageRoutesOptions = {
  router: Router;
  vite: ViteDevServer;
  /** v5/app/src — pages live under "<appSrcRoot>/web/**". */
  appSrcRoot: string;
  /** v5/app/src/web/root.tsx — the single global app-root file. */
  appFile: string;
  /**
   * The application root Vite's dev server serves from — `dev-error-transport.ts`'s
   * `paths.appRoot`, i.e. `<appRoot>/src === appSrcRoot` by default. Every
   * handler's stylesheet URLs are expressed relative to THIS, because that is
   * the root Vite's dev server actually resolves `/…` URLs against
   * (`stylesheet-urls.ts`'s `devStylesheetUrls`) — not `appSrcRoot`, which is
   * one directory level in.
   *
   * OPTIONAL and defaulted to `path.dirname(appSrcRoot)`: the caller that
   * wires dev boot (`web-connector.ts`) does not pass this field today, and
   * that default is exactly the relationship it constructs `appSrcRoot` from
   * (`appSrcRoot = path.join(appRoot, "src")`) — correct for every actual
   * deployment, and overridable by a caller with a non-default layout.
   */
  appRoot?: string;
  /** Dev connector's persisted raw locale graph, replaced after a successful installation. */
  routeLocaleArtifactPath?: string;
  /** Browser module loaded after the server-rendered application and payload. */
  hydrationClientModuleUrl?: string;
  /**
   * UNUSED. Retained on this type only because `web-connector.ts` still builds
   * an options object naming it (`devStylesheetUrls(paths.appRoot,
   * paths.appFile)`, computed once for the whole application). Each handler
   * now computes its OWN stylesheet chain — `[root, ...outer-to-inner matched
   * layouts, page]`, via `devHandlerStylesheetUrls` — inside the registration
   * loop below, because a single application-wide list cannot express "this
   * page's own CSS" without also carrying every other page's.
   */
  stylesheetUrls?: readonly string[];
  /**
   * The Fastify instance `HttpConnector.boot()` published, resolved by the
   * caller on the NODE side (`web-connector.ts`) and forwarded to every
   * `createPageRouteHandler` call below instead of letting that factory read
   * `container.get("http.server")` for itself.
   *
   * Load-bearing, not a convenience: Vite's SSR module runner
   * (`vite.ssrLoadModule`, used throughout this file) evaluates
   * `create-page-route-handler.ts` as a SECOND copy of `@warlock.js/core`, with
   * its own `container` that `HttpConnector.boot()` never wrote to. Reading the
   * container from inside that SSR graph therefore always misses, however
   * early or late this file calls it — the value has to arrive as a plain
   * argument from a caller on the Node side, where the real container lives.
   *
   * OPTIONAL so existing callers (and this file's own unit tests, which seed
   * `container.set("http.server", …)` instead) keep resolving through the
   * container exactly as before — omitted here means "not supplied", the same
   * distinction `createPageRouteHandler` itself draws from `PageRouteHandlerOptions.httpServer`.
   */
  httpServer?: FastifyInstance;
};

/**
 * Registers every discoverable page into `options.router`. Throws
 * IMMEDIATELY, naming both files, the moment two pages declare the same
 * `route.path` — a registration-time failure, not a runtime 404 one of them
 * silently loses.
 *
 * Pages with no `route` export derive their path and name from their location
 * below `src/web`, using the same pure filesystem-routing helper as the build.
 */
export async function installPageRoutes(
  options: InstallPageRoutesOptions,
): Promise<InstalledPageRoute[]> {
  normalizePageModule(await options.vite.ssrLoadModule(options.appFile), "root", options.appFile);
  const discoveredGraph = discoverPageFileGraph(options.appSrcRoot);
  const graph = {
    pages: [
      ...discoveredGraph.pages,
      { pageFile: options.appFile, webRoot: path.dirname(options.appFile) },
    ],
    localeFiles: discoveredGraph.localeFiles,
  };
  const localeOptions = {
    localeCodes: config.key<readonly string[] | undefined>("app.localeCodes"),
    localeCode: config.key<string | undefined>("app.localeCode"),
  };
  const artifact =
    options.routeLocaleArtifactPath === undefined
      ? undefined
      : prepareDevRouteLocaleArtifact({
          graph,
          appRoot: options.appRoot ?? path.dirname(options.appSrcRoot),
          artifactPath: options.routeLocaleArtifactPath,
          ...localeOptions,
        });
  try {
    return await installDiscoveredPageRoutes(
      options,
      discoveredGraph,
      artifact === undefined ? buildRouteLocaleManifest(graph, localeOptions) : artifact.manifest,
      artifact?.commit,
    );
  } finally {
    artifact?.dispose();
  }
}

async function installDiscoveredPageRoutes(
  options: InstallPageRoutesOptions,
  discoveredGraph: DiscoveredPageFileGraph,
  routeLocaleManifest: RouteLocaleManifest | undefined,
  commitLocaleArtifact?: () => void,
): Promise<InstalledPageRoute[]> {
  const { router, vite, appSrcRoot, appFile, hydrationClientModuleUrl, httpServer } = options;
  // Spread conditionally, never as a bare `httpServer,` property: an explicit
  // `httpServer: undefined` key is its own signal to `createPageRouteHandler`
  // (`"httpServer" in options"`, `create-page-route-handler.ts`) — "no server,
  // on purpose" — and this file must not manufacture that signal on behalf of
  // a caller (this file's own unit tests, most callers) that never supplied
  // one and means to fall back to the container instead.
  const httpServerOption = httpServer === undefined ? {} : { httpServer };
  // See `InstallPageRoutesOptions.appRoot` for why this default, not
  // `appSrcRoot` itself, is the root every handler's CSS is resolved against.
  const stylesheetRoot = options.appRoot ?? path.dirname(appSrcRoot);
  // Per-request `linkStylesheetsFor()` declarations. Resolved at request time
  // against the live module graph, so transitive CSS appears once warm; the
  // declared file's own imports are read directly, so a cold graph still links.
  const resolveRequestStylesheetUrls: RequestStylesheetUrlResolver = (sourceFiles) =>
    devDeclaredStylesheetUrls(stylesheetRoot, sourceFiles, vite.moduleGraph);
  // Resolved once, up front: every page's registrations below (and the
  // catch-all's absence of them) are decided against this one value, and
  // publishing it once after the loop keeps it in step with `publishRouteTable`.
  const localeRouting = resolveLocaleRouting();
  const discovered = [...discoveredGraph.pages].sort((left, right) =>
    left.pageFile < right.pageFile ? -1 : left.pageFile > right.pageFile ? 1 : 0,
  );
  const getRouteTranslations = createRouteTranslationsResolver(routeLocaleManifest);

  // THE NOT-FOUND PAGE IS TAKEN OUT OF THE ORDINARY LOOP, not filtered inside
  // it. It has no `route` export to read, no path to compose and no collision
  // to check — every step below is about a page with a URL, and `404.page.tsx`
  // does not have one. Registering it here would put it at `/404`, which is not
  // a page anybody asked to be able to visit.
  const errorPageFiles = discovered.filter((page) => isErrorPageFile(page.pageFile));
  const notFoundPageFiles = discovered.filter((page) => isNotFoundPageFile(page.pageFile));
  const pageFiles = discovered.filter(
    (page) => !isNotFoundPageFile(page.pageFile) && !isErrorPageFile(page.pageFile),
  );

  if (errorPageFiles.length > 1) {
    throw new Error(
      `Two error pages were found: ${errorPageFiles.map((page) => page.pageFile).join(", ")}.`,
    );
  }

  const errorPageFile = errorPageFiles[0]?.pageFile;

  // Parse only: the error boundary must remain lazy until a request actually
  // fails, while a route export is still rejected at install time.
  if (errorPageFile !== undefined) {
    const declarations = readModuleConfig(
      errorPageFile,
      readFileSync(errorPageFile, "utf-8"),
      "page",
    );
    if (declarations.route !== undefined) throw new ErrorPageDeclaresRouteError(errorPageFile);
  }
  const loadErrorPage =
    errorPageFile === undefined
      ? undefined
      : () => vite.ssrLoadModule(errorPageFile) as Promise<ErrorPageModule>;

  if (notFoundPageFiles.length > 1) {
    throw new DuplicateNotFoundPageError(notFoundPageFiles.map((page) => page.pageFile));
  }

  // The not-found page's handler, handed to every page below as a GETTER: a
  // page whose loader answers `notFound()` renders this same document. It is
  // assigned in the catch-all block after the loop — its CSS chain is read
  // off the module graph the loop warms — and read per request, so each
  // install's pages see the handler THAT install built, including none once
  // `404.page.tsx` is deleted.
  let notFoundPageHandler: PageRouteHandler | undefined;
  const renderNotFound = () => notFoundPageHandler;

  const installed: InstalledPageRoute[] = [];
  const fileByPath = new Map<string, string>();

  for (const { pageFile, webRoot } of pageFiles) {
    let rawPageModule: unknown;

    try {
      rawPageModule = await vite.ssrLoadModule(pageFile);
    } catch (loadError) {
      // THE PAGE ITSELF MUST NOT ABORT THE INSTALL: every other page still
      // needs to install and serve. Layout loading is deliberately NOT
      // wrapped here — a broken layout is a different failure with a
      // different blast radius (it can affect more than one page) and is out
      // of this card's scope.
      await registerFailedPageRoute({ router, pageFile, appSrcRoot, loadError, fileByPath });

      continue;
    }

    const pageModule = normalizePageModule(rawPageModule, "page", pageFile);
    const sourceFile = canonicalSourceFileFor(pageFile, appSrcRoot);

    // Route identity is explicit when declared and filesystem-derived otherwise.
    const { path: routePath, name } = resolvePageRouteIdentity(
      pageModule.route,
      filesystemPageFileFor(pageFile, appSrcRoot),
      pageFile,
    );

    // Validated at INSTALL time, with everything else — a malformed `cache`
    // opt-in fails boot, not the first request that would have served it.
    const cache = pageModule.cache;

    const loadLayout: LoadLayout = async (layoutFile) =>
      normalizePageModule(await vite.ssrLoadModule(layoutFile), "layout", layoutFile);
    const layoutLevel = await resolveLayoutLevel(pageFile, webRoot, loadLayout);
    const { layoutFile, prefix: layoutPrefix } = layoutLevel;

    const effectivePath =
      pageModule.route === undefined
        ? deriveFilesystemRoutePath({
            pageFile: filesystemPageFileFor(pageFile, appSrcRoot),
            layoutPrefixes: layoutLevel.prefixesByDirectory,
          })
        : composeRoutePath(layoutPrefix, routePath);

    const existingFile = fileByPath.get(effectivePath);

    if (existingFile) {
      throw new Error(
        duplicateRoutePathMessage({
          effectivePath,
          existingFile,
          newFile: pageFile,
          composition: { layoutPrefix, routePath },
        }),
      );
    }

    fileByPath.set(effectivePath, pageFile);

    // Every registered handler gets ITS OWN immutable, ordered, deduped CSS
    // chain: root, then every matched layout outer to inner
    // (`layoutLevel.chain`), then the page — the same order the render
    // pipeline loads that chain in, so cascade order matches load order.
    // Computed once here, at registration, not per request: dev re-registers
    // on every restart, so a stale chain cannot outlive the source edit that
    // changed it.
    const stylesheetUrls = devHandlerStylesheetUrls(
      stylesheetRoot,
      [appFile, ...layoutLevel.chain, pageFile],
      vite.moduleGraph,
    );

    // The handler itself is `createPageRouteHandler`
    // (`web/src/server/create-page-route-handler.ts`) — a named seam a future
    // `type: "page"` route can bind to, and testable without a Vite server.
    // Vite appears here only as the dev answer to "how do I load a module";
    // the handler takes that as an input and knows nothing else about it.
    const pageHandler = createPageRouteHandler({
      path: effectivePath,
      name,
      appFile,
      pageFile,
      layoutFile,
      // The layout slot's id resolves to the COMPOSED level — every layout's
      // middleware, in chain order, and its validated static metadata — while
      // every other id goes straight to Vite.
      loadModule: (moduleId) => vite.ssrLoadModule(moduleId),
      loadComposedLayout:
        layoutFile === undefined
          ? undefined
          : () => composeLayoutLevel({ ...layoutLevel, layoutFile }, loadLayout),
      // Registration tracks real module namespaces, not the composed
      // layout wrapper above. Loading the raw chain per request also lets
      // Vite hand over a replacement namespace after an HMR update; the
      // helper's WeakSet then gives that new identity its one invocation.
      loadRegistrationLayouts: () =>
        Promise.all(layoutLevel.chain.map((layoutFile) => vite.ssrLoadModule(layoutFile))),
      hydrationClientModuleUrl,
      loadErrorPage,
      errorPageFile,
      getRouteTranslations,
      stylesheetUrls,
      resolveRequestStylesheetUrls,
      cache,
      renderNotFound,
      ...httpServerOption,
    });

    // Under an active `web.localeRouting.strategy` this is more than one
    // registration — the base path (possibly rewritten into a locale
    // redirect) plus one literal path per prefixed code
    // (`./locale-routing/locale-page-registrations.ts`). Under `"none"` it is
    // exactly the base registration, unchanged.
    await router.withSourceFile(sourceFile, () => {
      for (const registration of localePageRegistrations(
        effectivePath,
        name,
        pageHandler,
        localeRouting,
        { pageFile, renderNotFound },
      )) {
        router.get(
          registration.path,
          registration.handler,
          // `isPage` marks this route as SSR-served. Pages and API routes
          // share one router and one route-name namespace, so the router's
          // duplicate-name error reads this flag to say which claimant is the
          // page. The name stays on the base registration only.
          { name: registration.name, isPage: true },
        );
      }
    });

    installed.push({
      declaredPath: routePath,
      path: effectivePath,
      name,
      file: pageFile,
      layoutFile,
    });
  }

  /*
    THE CATCH-ALL, registered LAST and only when this application has a page
    surface at all. "Configured with web, no pages yet" is a legal state, and an
    application serving no pages has no page 404 to answer with — its unmatched
    URLs stay core's to answer, exactly as they are today.

    Registered even when the application ships no `404.page.tsx`: the framework
    default still answers 404, so an application that has not written one yet
    gets the right STATUS from the first request, and adding the file later
    changes the body and nothing else.
  */
  if (pageFiles.length > 0 || notFoundPageFiles.length > 0) {
    const notFoundPageFile = notFoundPageFiles[0]?.pageFile;

    // Read at INSTALL time, so a `route` export on the not-found page is
    // refused at boot with everything else — not on the first request that
    // misses, which is the one request nobody is watching.
    if (notFoundPageFile !== undefined) {
      const notFoundModule = normalizePageModule(
        await vite.ssrLoadModule(notFoundPageFile),
        "page",
        notFoundPageFile,
      );

      if (notFoundModule.route !== undefined) {
        throw new NotFoundPageDeclaresRouteError(notFoundPageFile);
      }
    }

    // Built ONCE and shared: the catch-all renders it for an unmatched URL,
    // and every page above reaches it through `renderNotFound` for a loader
    // `notFound()`.
    notFoundPageHandler =
      notFoundPageFile === undefined
        ? undefined
        : createPageRouteHandler({
            ...notFoundPageHandlerOptions({
              appFile,
              pageFile: notFoundPageFile,
              loadModule: (moduleId) => vite.ssrLoadModule(moduleId),
              hydrationClientModuleUrl,
              loadErrorPage,
              errorPageFile,
              getRouteTranslations,
              // NO LAYOUT means no layout CSS either — just root and the
              // not-found page's own stylesheets, same reasoning as the
              // shared helper's own header comment.
              stylesheetUrls: devHandlerStylesheetUrls(
                stylesheetRoot,
                [appFile, notFoundPageFile],
                vite.moduleGraph,
              ),
              resolveRequestStylesheetUrls,
            }),
            ...httpServerOption,
          });

    const registerNotFoundRoute = () =>
      registerNotFoundPageRoute({ router, renderPage: notFoundPageHandler });

    if (notFoundPageFile === undefined) {
      await router.withSourceFile(FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE, registerNotFoundRoute);
    } else {
      await router.withSourceFile(
        canonicalSourceFileFor(notFoundPageFile, appSrcRoot),
        registerNotFoundRoute,
      );
    }
  }

  /*
    Published from the SAME loop that registered the routes, so `href()` and the
    router cannot disagree about where a name points. It happens here rather
    than in the caller because a caller that forgets leaves every `<Link>` on
    the server throwing at render — and dev republishes on every restart, which
    is why the table replaces wholesale instead of merging: a deleted page's
    name has to stop resolving.
  */
  const publishRoutes = prepareRouteTable(installed, "installPageRoutes (dev)");
  commitLocaleArtifact?.();
  publishRoutes();
  publishLocaleRouting(localeRouting);

  return installed;
}
