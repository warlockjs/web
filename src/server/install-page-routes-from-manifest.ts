/**
 * Page-route registration for a built application.
 *
 * `installPageRoutes` answers "which pages exist?" by walking the filesystem
 * and "what is this module?" by asking Vite to evaluate it. Neither question
 * can be asked of a running production process: there is no `app/` tree beside
 * the bundle and no Vite. Both answers were therefore moved to build time — the
 * generated `pages.ts` barrel statically imported every page, layout and the
 * app root and handed them over as a {@link PageManifest}, and this module
 * turns that table into registered routes.
 *
 * WHAT IS DELIBERATELY IDENTICAL TO DEVELOPMENT: the route a page ends up on,
 * and the guards that run before it renders. A page's `route` export and the
 * `prefix` and `middleware` exports of EVERY layout on its path are read off the
 * module namespaces here, at boot, and composed by the same rules dev composes
 * them by ({@link layoutLevelOf}, {@link composeLayoutLevel}) — so the URL a page
 * answers on and the chain that guards it are decided by the page's own source
 * in both modes, and a build cannot quietly disagree with the dev server about
 * either.
 *
 * WHAT IS DELIBERATELY DIFFERENT: this is synchronous. Every module is already
 * in memory, so registration has nothing to await; the loader handed to each
 * handler is a lookup over the same table, not an evaluation step.
 */
import { composeRoutePath } from "../routing/compose-route-path";
import { NestedLayoutsNotSupportedError, selectPageLayout } from "../routing/layout-policy";
import { canonicalizeRouteExport, deriveFallbackRouteName } from "../routing/route-identity";
import { publishRouteTable } from "../routing/route-table";
import type { Response, Router } from "@warlock.js/core";
import type { BufferedCookie } from "./buffered-response";
import { createPageModuleLoader } from "./create-page-module-loader";
import {
  createPageRouteHandler,
  type PageRouteHandler,
  type PageRouteHandlerOptions,
} from "./create-page-route-handler";
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
import type { PageManifest, PageManifestLayoutEntry, PageManifestPageEntry } from "./page-manifest";

/** A page declares either a bare path or a path plus an explicit route name. */
type PageRouteExport = string | { path: string; name?: string };

/** The only export this module reads off a page module namespace. */
type PageModuleShape = {
  route?: PageRouteExport;
};

/** The exports this module reads off a layout module namespace. */
type LayoutModuleShape = {
  prefix?: string;
  /**
   * The default export — the thing that puts an element in the document, and
   * therefore the ONLY export that decides whether a layout counts against the
   * single-rendering-layout rule (`../routing/layout-policy.ts`). The manifest
   * carries LOADED modules, so this is a fact rather than a guess, exactly as it
   * is in dev (`install-page-routes.ts:145-150`).
   */
  default?: unknown;
  /** The layout's guards, in the order it declared them. */
  middleware?: readonly PipelineMiddleware[];
};

/**
 * How a handler is built for one page. Defaults to `createPageRouteHandler`;
 * taking it as an input keeps this module's own job — reading the manifest and
 * registering routes — provable without a render pipeline behind it.
 */
export type PageRouteHandlerFactory = (options: PageRouteHandlerOptions) => PageRouteHandler;

export type InstalledManifestPageRoute = {
  /** The composed path the route was registered on. */
  path: string;
  /** The resolved route name; shared namespace with API routes. */
  name: string;
  /** The page's manifest `sourceFile`. */
  file: string;
  /** The layout's manifest `sourceFile`, when the page has one. */
  layoutFile: string | undefined;
};

export type InstallPageRoutesFromManifestOptions = {
  router: Router;
  /** The table the generated production barrel provided at import time. */
  manifest: PageManifest;
  /** Browser module loaded after the server-rendered application and payload. */
  hydrationClientModuleUrl?: string;
  /** Stylesheet URLs emitted into every page's `<head>`. */
  stylesheetUrls?: readonly string[];
  /** Same helper `dev-server.ts` exports — passed in, never imported. */
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void;
  createHandler?: PageRouteHandlerFactory;
};

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

/**
 * The page's layout LEVEL, resolved from the whole chain the manifest carries
 * rather than from the one layout nearest to it — the same resolution dev makes
 * (`install-page-routes.ts:138-164`), against loaded modules instead of Vite's.
 *
 * The manifest carries the FULL chain, outermost first, and the render pipeline
 * has exactly one layout slot per page (`execute-page-request.ts`'s
 * `PageRouteEntry["triple"]`), so the chain has to be collapsed into one module
 * before it reaches a handler. Two things collapse differently and both matter:
 *
 * - RENDERING is a selection: at most one layout on the chain may render, and
 *   the policy picks it. `renders` is read off the loaded module
 *   (`typeof module.default !== "undefined"`), never off the entry's presence in
 *   the chain — a `middleware`-only layout has no default export and is not a
 *   wrapper. Passing bare `sourceFile` strings had every layout read as a
 *   rendering one, so boot refused a middleware-only guard chain that the build
 *   had already accepted: an application that builds and will not start.
 * - MIDDLEWARE and PREFIX are compositions: every layout on the path
 *   contributes, outermost first. A guard on an outer layout that the page's own
 *   directory knows nothing about is exactly the guard that must still run, and
 *   a prefix nobody composed is a URL nobody wrote down.
 *
 * A chain with more than one RENDERING layout is still refused here, at boot,
 * before a single request can observe the wrong document. Like the missing
 * app-root refusal below, that arm defends against stale or hand-edited build
 * artifacts: the build refuses to emit such a chain, but a manifest can reach a
 * running process without that build having produced it.
 */
type LayoutLevel = {
  /**
   * The layout entry the handler's layout slot is registered under, or
   * `undefined` when the page has no layout at all: the layout that RENDERS,
   * or — when none does — the nearest one, which is the slot production has
   * always used and so the choice that changes nothing but the middleware for a
   * chain with no wrapper in it.
   */
  host: PageManifestLayoutEntry | undefined;
  /** Every layout's `prefix`, composed outermost first — `discoverPages`' own reduction. */
  prefix: string;
};

function layoutLevelOf(page: PageManifestPageEntry): LayoutLevel {
  const selection = selectPageLayout(
    page.layouts.map((layout) => ({
      layout: layout.sourceFile,
      renders: typeof (layout.module as LayoutModuleShape).default !== "undefined",
    })),
  );

  if (selection.type === "rejected") {
    throw new NestedLayoutsNotSupportedError(page.sourceFile, selection.layouts);
  }

  return {
    host:
      selection.type === "selected"
        ? page.layouts.find((layout) => layout.sourceFile === selection.layout)
        : page.layouts.at(-1),
    prefix: page.layouts.reduce(
      (composed, layout) =>
        composeRoutePath(composed, (layout.module as LayoutModuleShape).prefix ?? "/"),
      "/",
    ),
  };
}

/**
 * The layout slot's module for one page: the slot host's own namespace, with the
 * whole chain's middleware in place of its own — outermost first, which is the
 * order stage 3 runs the array in (`execute-page-request.ts:519-524`) and the
 * order an outer `optionalAuth` needs in order to have resolved an identity
 * before an inner `gate()` checks it.
 *
 * Deliberately NOT core's route-level `middleware` option: that runs before the
 * pipeline's App-level middleware, which would invert outermost-first — the one
 * property this composition exists to guarantee.
 *
 * Built once at registration, not per request: unlike dev, every module here is
 * already in memory and cannot change under a running process.
 */
function composeLayoutLevel(
  page: PageManifestPageEntry,
  host: PageManifestLayoutEntry,
): Record<string, unknown> {
  return {
    ...host.module,
    middleware: page.layouts.flatMap((layout) => [
      ...((layout.module as LayoutModuleShape).middleware ?? []),
    ]),
  };
}

/**
 * Registers every page the manifest carries into `options.router`.
 *
 * An empty manifest registers nothing and is not an error: "built with web, no
 * pages" is a legal state of a built application, and treating it as a failure
 * would make an empty project unbootable. A manifest that DOES carry pages but
 * no app root is the opposite — every page renders inside the application root,
 * so that combination is a broken table rather than an empty one, and it is
 * refused before any route exists to serve a request with a missing root.
 *
 * Two pages composing to the same path is refused the moment the second one is
 * seen, naming both — a registration-time failure, rather than a route one of
 * them silently loses at runtime.
 */
export function installPageRoutesFromManifest(
  options: InstallPageRoutesFromManifestOptions,
): InstalledManifestPageRoute[] {
  const {
    router,
    manifest,
    hydrationClientModuleUrl,
    stylesheetUrls,
    applyBufferedCookie,
    createHandler = createPageRouteHandler,
  } = options;

  if (manifest.pages.length === 0) return [];

  const app = manifest.app;

  if (app === undefined) {
    throw new Error(
      `installPageRoutesFromManifest: this build's page manifest carries ${manifest.pages.length} ` +
        "page(s) but no application root. Every page renders inside the app component, so no " +
        "page can be registered without it. Re-run the build so the generated pages barrel " +
        "provides an `app` entry.",
    );
  }

  // Ids are the manifest's own `sourceFile` strings and are passed on untouched:
  // the loader below matches them by exact string equality, so resolving,
  // joining or swapping separators on one side of that comparison would turn
  // every lookup into a miss.
  const loadModule = createPageModuleLoader(manifest);

  // Same partition development makes, on the same rule (the filename), so the
  // two modes cannot disagree about which file is the not-found page. It is
  // taken OUT of the registration loop rather than skipped inside it: every step
  // in there composes and claims a URL, and `404.page.tsx` has none.
  const notFoundPages = manifest.pages.filter((page) => isNotFoundPageFile(page.sourceFile));
  const pages = manifest.pages.filter((page) => !isNotFoundPageFile(page.sourceFile));

  if (notFoundPages.length > 1) {
    throw new DuplicateNotFoundPageError(notFoundPages.map((page) => page.sourceFile));
  }

  const notFoundPage = notFoundPages[0];

  if (notFoundPage !== undefined && (notFoundPage.module as PageModuleShape).route !== undefined) {
    throw new NotFoundPageDeclaresRouteError(notFoundPage.sourceFile);
  }

  const installed: InstalledManifestPageRoute[] = [];
  const fileByPath = new Map<string, string>();

  for (const page of pages) {
    const { host: layout, prefix: layoutPrefix } = layoutLevelOf(page);
    const routeExport = (page.module as PageModuleShape).route;

    // A page that declares no route has no public URL to be registered under —
    // the same page discovery skips in development.
    if (routeExport === undefined) continue;

    const { path: routePath, name } = resolveRoute(routeExport, page.sourceFile);
    const effectivePath = composeRoutePath(layoutPrefix, routePath);
    const existingFile = fileByPath.get(effectivePath);

    if (existingFile) {
      throw new Error(
        `installPageRoutesFromManifest: composed route path "${effectivePath}" (layout ` +
          `prefix "${layoutPrefix}" + route.path "${routePath}") is declared by two pages — ` +
          `"${existingFile}" and "${page.sourceFile}". Every page's composed route path must ` +
          "be unique.",
      );
    }

    fileByPath.set(effectivePath, page.sourceFile);

    // The layout slot's id resolves to the COMPOSED level — every layout's
    // middleware, in chain order — and every other id goes straight to the
    // manifest lookup. A one-layout chain has nothing to compose, so it is left
    // to resolve as the exact namespace object the manifest carries, untouched.
    const composedLayout =
      page.layouts.length > 1 && layout !== undefined
        ? composeLayoutLevel(page, layout)
        : undefined;

    router.get(
      effectivePath,
      createHandler({
        path: effectivePath,
        name,
        appFile: app.sourceFile,
        pageFile: page.sourceFile,
        layoutFile: layout?.sourceFile,
        loadModule:
          composedLayout === undefined
            ? loadModule
            : (moduleId) =>
                moduleId === layout?.sourceFile
                  ? Promise.resolve(composedLayout)
                  : loadModule(moduleId),
        hydrationClientModuleUrl,
        stylesheetUrls,
        applyBufferedCookie,
      }),
      // `isPage` marks this route as SSR-served. Pages and API routes share one
      // router and one route-name namespace, so the router's duplicate-name
      // error reads this flag to say which claimant is the page.
      { name, isPage: true },
    );

    installed.push({
      path: effectivePath,
      name,
      file: page.sourceFile,
      layoutFile: layout?.sourceFile,
    });
  }

  /*
    THE CATCH-ALL — the same route dev registers, built the same way, differing
    only in where a module comes from. Registered last, and registered even when
    the build carried no `404.page.tsx`, so a production deployment answers 404
    with the right STATUS whether or not anyone has designed the page yet.
  */
  router.get(
    NOT_FOUND_ROUTE_PATH,
    createNotFoundRouteHandler({
      renderPage:
        notFoundPage === undefined
          ? undefined
          : createHandler({
              path: NOT_FOUND_ROUTE_PATH,
              name: NOT_FOUND_ROUTE_NAME,
              appFile: app.sourceFile,
              pageFile: notFoundPage.sourceFile,
              // No layout, and therefore no layout middleware — see the dev
              // installer for why the not-found path takes nothing that can
              // redirect or throw.
              layoutFile: undefined,
              loadModule,
              hydrationClientModuleUrl,
              stylesheetUrls,
              applyBufferedCookie,
              matchPath: (requestPath) => requestPath,
              statusForRenderedOk: 404,
            }),
    }),
    // `isPage` for the same reason the dev installer carries it — the router's
    // duplicate-name error reads the flag to say which claimant is the page.
    { name: NOT_FOUND_ROUTE_NAME, isPage: true },
  );

  /*
    Same publish as the dev installer, for the same reason: `href()` and the
    router must agree, and they only can if both read the one loop that
    registered the routes. Production installs once at boot, so the wholesale
    replacement is a single write before the first request.
  */
  publishRouteTable(installed, "installPageRoutesFromManifest (production)");

  return installed;
}
