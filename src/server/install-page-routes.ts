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
 * shares — so this file owns no directory-walking of its own and serves the
 * global root (`<appSrcRoot>/web/**`) exactly as it serves a module's
 * (`<appSrcRoot>/app/<module>/web/**`). WHAT ROUTE A PAGE ANSWERS ON stays
 * this file's own job: each page and its nearest layout are still evaluated
 * through Vite (`vite.ssrLoadModule`), never read statically, because a dev
 * page module must be the one Vite serves, warm cache and all.
 */
import path from "node:path";
import type { ViteDevServer } from "vite";
import {
  discoverPageFiles,
  layoutChainFor,
  MissingRouteExportError,
  toPosix,
} from "../build/discover-pages";
import { composeRoutePath } from "../routing/compose-route-path";
import { NestedLayoutsNotSupportedError, selectPageLayout } from "../routing/layout-policy";
import { canonicalizeRouteExport, deriveFallbackRouteName } from "../routing/route-identity";
import { publishRouteTable } from "../routing/route-table";
import type { Response, Router } from "@warlock.js/core";
import type { BufferedCookie } from "./buffered-response";
import { createPageRouteHandler } from "./create-page-route-handler";
import type { PipelineMiddleware } from "./execute-page-request";
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
  path: string;
  name: string;
  file: string;
  layoutFile: string | undefined;
};

/**
 * The page's app-root-relative POSIX source path, e.g.
 * ".../v5/app/src/app/main/web/home.page.tsx" with appSrcRoot
 * ".../v5/app/src" -> "src/app/main/web/home.page.tsx" — the canonical form
 * `deriveFallbackRouteName` (`../routing/route-identity`) requires. The first
 * segment's actual name is arbitrary to that function (it only inspects the
 * segment AFTER it), so `appSrcRoot`'s own basename is used rather than
 * discovering the true app root.
 */
function canonicalSourceFileFor(pageFile: string, appSrcRoot: string): string {
  return `${path.basename(appSrcRoot)}/${toPosix(path.relative(appSrcRoot, pageFile))}`;
}

function resolveRoute(
  routeExport: PageRouteExport,
  sourceFile: string,
): { path: string; name: string } {
  const canonical = canonicalizeRouteExport(routeExport);

  return {
    path: canonical.path,
    name: canonical.name ?? deriveFallbackRouteName({ routePath: canonical.path, sourceFile }),
  };
}

export type LayoutModuleShape = {
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
  const host = modules[level.chain.indexOf(level.layoutFile)];

  return {
    ...host,
    middleware: modules.flatMap(layoutModule => [...(layoutModule.middleware ?? [])]),
  };
}

export type InstallPageRoutesOptions = {
  router: Router;
  vite: ViteDevServer;
  /** v5/app/src — pages live under "<appSrcRoot>/app/*\/web/**" and "<appSrcRoot>/web/**". */
  appSrcRoot: string;
  /** v5/app/src/web/root.tsx — the single global app-root file. */
  appFile: string;
  /** Browser module loaded after the server-rendered application and payload. */
  hydrationClientModuleUrl?: string;
  /**
   * Stylesheet URLs emitted into every page's `<head>`.
   *
   * In dev these are Vite source URLs; see `devStylesheetUrls` for why they
   * carry `?direct`.
   */
  stylesheetUrls?: readonly string[];
  /** Same helper `dev-server.ts` exports — passed in, not imported, to avoid a dev-server.ts <-> this-file cycle. */
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void;
};

/**
 * Registers every discoverable page into `options.router`. Throws
 * IMMEDIATELY, naming both files, the moment two pages declare the same
 * `route.path` — a registration-time failure, not a runtime 404 one of them
 * silently loses.
 *
 * Pages with no `route` export are REFUSED, not skipped, with the same
 * `MissingRouteExportError` the build throws: discovery cannot invent a public
 * URL for an undeclared page, and a dev server that silently drops the file you
 * just wrote is indistinguishable from a typo in the URL.
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
    stylesheetUrls,
    applyBufferedCookie,
  } = options;
  const discovered = [...discoverPageFiles(appSrcRoot)].sort((left, right) =>
    left.pageFile < right.pageFile ? -1 : left.pageFile > right.pageFile ? 1 : 0,
  );

  // THE NOT-FOUND PAGE IS TAKEN OUT OF THE ORDINARY LOOP, not filtered inside
  // it. It has no `route` export to read, no path to compose and no collision
  // to check — every step below is about a page with a URL, and `404.page.tsx`
  // does not have one. Registering it here would put it at `/404`, which is not
  // a page anybody asked to be able to visit.
  const notFoundPageFiles = discovered.filter((page) => isNotFoundPageFile(page.pageFile));
  const pageFiles = discovered.filter((page) => !isNotFoundPageFile(page.pageFile));

  if (notFoundPageFiles.length > 1) {
    throw new DuplicateNotFoundPageError(notFoundPageFiles.map((page) => page.pageFile));
  }

  const installed: InstalledPageRoute[] = [];
  const fileByPath = new Map<string, string>();

  for (const { pageFile, webRoot } of pageFiles) {
    const pageModule = (await vite.ssrLoadModule(pageFile)) as PageModuleShape;

    const sourceFile = canonicalSourceFileFor(pageFile, appSrcRoot);

    // Same condition, same error, same wording the build already throws
    // (`MissingRouteExportError`, `web/src/build/discover-pages.ts`) — dev used
    // to `continue` here, so a page you had just written vanished into a
    // not-found with nothing said. One condition, one verdict.
    if (pageModule.route === undefined) {
      throw new MissingRouteExportError(sourceFile);
    }

    const { path: routePath, name } = resolveRoute(pageModule.route, sourceFile);

    const loadLayout: LoadLayout = layoutFile =>
      vite.ssrLoadModule(layoutFile) as Promise<LayoutModuleShape>;
    const layoutLevel = await resolveLayoutLevel(pageFile, webRoot, loadLayout);
    const { layoutFile, prefix: layoutPrefix } = layoutLevel;

    const effectivePath = composeRoutePath(layoutPrefix, routePath);

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
          hydrationClientModuleUrl,
          stylesheetUrls,
          applyBufferedCookie,
        }),
        // `isPage` marks this route as SSR-served. Pages and API routes share one
        // router and one route-name namespace, so the router's duplicate-name
        // error reads this flag to say which claimant is the page.
        { name, isPage: true },
      ),
    );

    installed.push({ path: effectivePath, name, file: pageFile, layoutFile });
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
  if (discovered.length > 0) {
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
                  stylesheetUrls,
                  applyBufferedCookie,
                  // The URL that missed IS this route's pattern for this request.
                  matchPath: (requestPath) => requestPath,
                  statusForRenderedOk: 404,
                }),
        }),
        // `isPage` for the same reason every other page route carries it: the
        // router's duplicate-name error reads the flag to say which claimant is
        // the page.
        { name: NOT_FOUND_ROUTE_NAME, isPage: true },
      );

    if (notFoundPageFile === undefined) {
      registerNotFoundRoute();
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
