/**
 * Registers every page {@link discoverPageFiles} finds under `<appSrcRoot>`
 * into Warlock's router (`router.get`, `core/src/router/router.ts:359-361`)
 * so `router.scanDevServer(fastify)` —
 * the sanctioned dev-server dispatch path (server matching is Warlock's
 * router; there is no second server matcher) — picks
 * it up. Replaces the two hand-rolled `fastify.get()` calls this file's
 * sibling, `dev-server.ts`, used to make directly.
 *
 * DELIBERATE EXCEPTION to "web has no core dependency", same
 * reasoning `dev-server.ts`'s own header comment records: this module is not
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
import type { ViteDevServer } from "vite";
import {
  discoverPageFiles,
  ErrorPageDeclaresRouteError,
  isErrorPageFile,
  layoutChainFor,
  toPosix,
} from "../build/discover-pages";
import { NonLiteralRouteExportError, readRouteExports } from "../build/read-route-exports";
import { composeRoutePath } from "../routing/compose-route-path";
import { deriveFilesystemRoutePath } from "../routing/filesystem-route";
import { NestedLayoutsNotSupportedError, selectPageLayout } from "../routing/layout-policy";
import { canonicalizeRouteExport, resolvePageRouteName } from "../routing/route-identity";
import { publishRouteTable } from "../routing/route-table";
import { Response, type Router } from "@warlock.js/core";
import { createPageRouteHandler } from "./create-page-route-handler";
import type { ErrorPageModule } from "./error-page";
import type { PipelineLoader, PipelineMiddleware } from "./execute-page-request";
import { isLoaderShortCircuit } from "./settle-page-response";
import { devHandlerStylesheetUrls } from "./stylesheet-urls";
import {
  createNotFoundRouteHandler,
  DuplicateNotFoundPageError,
  isNotFoundPageFile,
  NotFoundPageDeclaresRouteError,
  NOT_FOUND_ROUTE_NAME,
  NOT_FOUND_ROUTE_PATH,
  type RegisteredRouteShape,
} from "./not-found-page";

/** Re-exported so `web/src/server/index.ts`'s existing barrel export keeps resolving. */
export { composeRoutePath };

export type PageRouteExport = string | { path: string; name?: string };

export type PageModuleShape = {
  route?: PageRouteExport;
};

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

function filesystemPageFileFor(pageFile: string, appSrcRoot: string): string {
  return toPosix(path.relative(path.join(appSrcRoot, "web"), pageFile));
}

/**
 * Resolve the stable identity used to distinguish a route-export edit from an
 * ordinary component-body edit. The declared path is retained before layout
 * composition so `/settings` under `/admin` compares with the next declared
 * `/settings`, not with the effective `/admin/settings` route.
 */
export function resolvePageRouteIdentity(
  routeExport: PageRouteExport | undefined,
  pageFile: string,
  appSrcRoot: string,
): Pick<InstalledPageRoute, "declaredPath" | "name"> {
  const filesystemPageFile = filesystemPageFileFor(pageFile, appSrcRoot);

  if (routeExport === undefined) {
    return {
      declaredPath: deriveFilesystemRoutePath({ pageFile: filesystemPageFile }),
      name: resolvePageRouteName(routeExport, filesystemPageFile),
    };
  }

  return {
    declaredPath: canonicalizeRouteExport(routeExport).path,
    name: resolvePageRouteName(routeExport, filesystemPageFile),
  };
}

export type LayoutModuleShape = {
  /** Universal registration hook; invoked on this real namespace, never a composed wrapper. */
  register?: () => unknown;
  prefix?: string;
  /**
   * The default export — the thing that puts an element in the document, and
   * therefore the ONLY export that decides whether a layout counts against the
   * single-rendering-layout rule (`../routing/layout-policy.ts`). In dev the
   * module is loaded, so this is a fact rather than a guess.
   */
  default?: unknown;
  /** The layout's guards, in the order it declared them. */
  middleware?: readonly PipelineMiddleware[];
  loader?: PipelineLoader;
};

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
 *   passing a bare path to `selectPageLayout` would have it read as a rendering
 *   one, which is the conservative default and the wrong answer here.
 * - MIDDLEWARE and PREFIX are compositions: every layout on the path
 *   contributes, outermost first. A guard on an outer layout that the page's
 *   own directory knows nothing about is exactly the guard that must still run,
 *   and a prefix nobody composed is a URL nobody wrote down.
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
  const modules = await Promise.all(chain.map(loadLayout));
  const selection = selectPageLayout(
    chain.map((layout, index) => ({
      layout,
      renders: typeof modules[index].default !== "undefined",
    })),
  );

  if (selection.type === "rejected") {
    throw new NestedLayoutsNotSupportedError(pageFile, selection.layouts);
  }

  return {
    chain,
    layoutFile: selection.type === "selected" ? selection.layout : chain.at(-1),
    prefix: modules.reduce(
      (composed, layoutModule) => composeRoutePath(composed, layoutModule.prefix ?? "/"),
      "/",
    ),
    prefixesByDirectory: Object.fromEntries(
      chain.flatMap((layoutFile, index) => {
        const prefix = modules[index].prefix;

        return prefix === undefined
          ? []
          : [[toPosix(path.relative(webRoot, path.dirname(layoutFile))), prefix]];
      }),
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
  const host = modules[hostIndex];

  return {
    ...host,
    middleware: modules.flatMap(layoutModule => [...(layoutModule.middleware ?? [])]),
    loader: async (context) => {
      let hostData: unknown;

      for (let index = 0; index < modules.length; index++) {
        const value = await modules[index].loader?.(context);

        if (value instanceof Response || isLoaderShortCircuit(value)) return value;
        if (index === hostIndex) hostData = value;
      }

      return hostData;
    },
  };
}

export type InstallPageRoutesOptions = {
  router: Router;
  vite: ViteDevServer;
  /** v5/app/src — pages live under "<appSrcRoot>/web/**". */
  appSrcRoot: string;
  /** v5/app/src/web/root.tsx — the single global app-root file. */
  appFile: string;
  /**
   * The application root Vite's dev server serves from — `dev-server.ts`'s
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
  /** Same helper `dev-server.ts` exports — passed in, not imported, to avoid a dev-server.ts <-> this-file cycle. */
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
  const {
    router,
    vite,
    appSrcRoot,
    appFile,
    hydrationClientModuleUrl,
  } = options;
  // See `InstallPageRoutesOptions.appRoot` for why this default, not
  // `appSrcRoot` itself, is the root every handler's CSS is resolved against.
  const stylesheetRoot = options.appRoot ?? path.dirname(appSrcRoot);
  const discovered = [...discoverPageFiles(appSrcRoot)].sort((left, right) =>
    left.pageFile < right.pageFile ? -1 : left.pageFile > right.pageFile ? 1 : 0,
  );

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
    throw new Error(`Two error pages were found: ${errorPageFiles.map((page) => page.pageFile).join(", ")}.`);
  }

  const errorPageFile = errorPageFiles[0]?.pageFile;

  // Parse only: the error boundary must remain lazy until a request actually
  // fails, while a route export is still rejected at install time.
  if (errorPageFile !== undefined) {
    const declarations = readRouteExports(errorPageFile);
    if (!declarations.ok) throw new NonLiteralRouteExportError(declarations.rejection);
    if (declarations.route !== undefined) throw new ErrorPageDeclaresRouteError(errorPageFile);
  }
  const loadErrorPage = errorPageFile === undefined
    ? undefined
    : () => vite.ssrLoadModule(errorPageFile) as Promise<ErrorPageModule>;

  if (notFoundPageFiles.length > 1) {
    throw new DuplicateNotFoundPageError(notFoundPageFiles.map((page) => page.pageFile));
  }

  const installed: InstalledPageRoute[] = [];
  const fileByPath = new Map<string, string>();

  for (const { pageFile, webRoot } of pageFiles) {
    const pageModule = (await vite.ssrLoadModule(pageFile)) as PageModuleShape;

    const sourceFile = canonicalSourceFileFor(pageFile, appSrcRoot);

    // Route identity is explicit when declared and filesystem-derived otherwise.
    const { declaredPath: routePath, name } = resolvePageRouteIdentity(
      pageModule.route,
      pageFile,
      appSrcRoot,
    );

    const loadLayout: LoadLayout = layoutFile =>
      vite.ssrLoadModule(layoutFile) as Promise<LayoutModuleShape>;
    const layoutLevel = await resolveLayoutLevel(pageFile, webRoot, loadLayout);
    const { layoutFile, prefix: layoutPrefix } = layoutLevel;

    const effectivePath = pageModule.route === undefined
      ? deriveFilesystemRoutePath({
          pageFile: filesystemPageFileFor(pageFile, appSrcRoot),
          layoutPrefixes: layoutLevel.prefixesByDirectory,
        })
      : composeRoutePath(layoutPrefix, routePath);

    const existingFile = fileByPath.get(effectivePath);

    if (existingFile) {
      throw new Error(
        `installPageRoutes: composed route path "${effectivePath}" (layout ` +
          `prefix "${layoutPrefix}" + route.path "${routePath}") is declared by two ` +
          `pages (web/src/server/install-page-routes.ts) — "${existingFile}" and ` +
          `"${pageFile}". Every page's composed route path must be unique.`,
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
    const stylesheetUrls = devHandlerStylesheetUrls(stylesheetRoot, [
      appFile,
      ...layoutLevel.chain,
      pageFile,
    ]);

    await router.withSourceFile(sourceFile, () =>
      router.get(
        effectivePath,
        // The handler itself is `createPageRouteHandler`
        // (`web/src/server/create-page-route-handler.ts`) — a named seam a
        // future `type: "page"` route can bind to, and testable without a Vite
        // server. Vite appears here only as the dev answer to "how do I load a
        // module"; the handler takes that as an input and knows nothing else
        // about it.
        createPageRouteHandler({
          path: effectivePath,
          name,
          appFile,
          pageFile,
          layoutFile,
          // The layout slot's id resolves to the COMPOSED level — every layout's
          // middleware, in chain order — and every other id goes straight to
          // Vite. A one-layout chain has nothing to compose, so it is left to
          // resolve as the exact module Vite hands back, untouched.
          loadModule:
            layoutLevel.chain.length > 1 && layoutFile !== undefined
              ? moduleId =>
                  moduleId === layoutFile
                    ? composeLayoutLevel({ ...layoutLevel, layoutFile }, loadLayout)
                    : vite.ssrLoadModule(moduleId)
              : moduleId => vite.ssrLoadModule(moduleId),
          // Registration tracks real module namespaces, not the composed
          // layout wrapper above. Loading the raw chain per request also lets
          // Vite hand over a replacement namespace after an HMR update; the
          // helper's WeakSet then gives that new identity its one invocation.
          loadRegistrationLayouts: () => Promise.all(layoutLevel.chain.map(loadLayout)),
          hydrationClientModuleUrl,
          loadErrorPage,
          stylesheetUrls,
        }),
        // `isPage` marks this route as SSR-served. Pages and API routes share one
        // router and one route-name namespace, so the router's duplicate-name
        // error reads this flag to say which claimant is the page.
        { name, isPage: true },
      ),
    );

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
      const notFoundModule = (await vite.ssrLoadModule(notFoundPageFile)) as PageModuleShape;

      if (notFoundModule.route !== undefined) {
        throw new NotFoundPageDeclaresRouteError(notFoundPageFile);
      }
    }

    const registerNotFoundRoute = () =>
      router.get(
        NOT_FOUND_ROUTE_PATH,
        createNotFoundRouteHandler({
          renderPage:
            notFoundPageFile === undefined
              ? undefined
              : createPageRouteHandler({
                  path: NOT_FOUND_ROUTE_PATH,
                  name: NOT_FOUND_ROUTE_NAME,
                  appFile,
                  pageFile: notFoundPageFile,
                  // NO LAYOUT, deliberately, and it is the same trade as "no
                  // loader on the 404 page": a layout brings its whole chain's
                  // middleware with it, and a guard that redirects or throws on
                  // the not-found path turns a missing page into an incident. The
                  // page renders inside the application root and nothing else.
                  layoutFile: undefined,
                  loadModule: (moduleId) => vite.ssrLoadModule(moduleId),
                  hydrationClientModuleUrl,
                  loadErrorPage,
                  // NO LAYOUT means no layout CSS either — just root and the
                  // not-found page's own stylesheets, same reasoning as above.
                  stylesheetUrls: devHandlerStylesheetUrls(stylesheetRoot, [
                    appFile,
                    notFoundPageFile,
                  ]),
                  // The URL that missed IS this route's pattern for this request.
                  matchPath: (requestPath) => requestPath,
                  statusForRenderedOk: 404,
                  skipPageLoader: true,
                }),
        }),
        // `isPage` for the same reason every other page route carries it: the
        // router's duplicate-name error reads the flag to say which claimant is
        // the page.
        { name: NOT_FOUND_ROUTE_NAME, isPage: true },
      );

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
  publishRouteTable(installed, "installPageRoutes (dev)");

  return installed;
}
