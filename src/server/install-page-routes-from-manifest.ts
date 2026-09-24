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
 * them by — a shared mechanism now, not a promise: {@link layoutLevelOf} calls
 * `../routing/layout-level.ts`'s `resolveLayoutLevel`, the same selection and
 * prefix-composition rule dev's own `resolveLayoutLevel` calls, and
 * {@link composeLayoutLevel} folds loaders through the same
 * `./fold-layout-loaders.ts` dev's does — so the URL a page answers on and the
 * chain that guards it are decided by the page's own source in both modes, and
 * a build cannot quietly disagree with the dev server about either.
 *
 * WHAT IS DELIBERATELY DIFFERENT: this is synchronous. Every module is already
 * in memory, so registration has nothing to await; the loader handed to each
 * handler is a lookup over the same table, not an evaluation step.
 */
import { composeRoutePath } from "../routing/compose-route-path";
import { duplicateRoutePathMessage } from "../routing/duplicate-route-path";
import { ErrorPageDeclaresRouteError } from "../routing/error-page-declares-route-error";
import { deriveFilesystemRoutePath } from "../routing/filesystem-route";
import { resolveLayoutLevel } from "../routing/layout-level";
import { resolvePageRouteIdentity } from "../routing/route-identity";
import { publishRouteTable } from "../routing/route-table";
import { publishLocaleRouting } from "../routing/locale-routing";
import { config, type Router } from "@warlock.js/core";
import path from "node:path";
import { buildRouteLocaleManifest } from "../build/build-route-locale-manifest";
import { composeLayoutModules } from "./compose-layout-modules";
import { composePageModule } from "./compose-page-module";
import { createPageModuleLoader } from "./create-page-module-loader";
import { resolveLocaleRouting } from "./locale-routing/resolve-locale-routing";
import { localePageRegistrations } from "./locale-routing/locale-page-registrations";
import type { ErrorPageModule } from "./error-page";
import {
  createPageRouteHandler,
  type PageRouteHandler,
  type PageRouteHandlerOptions,
} from "./create-page-route-handler";
import { layoutPrefixesByDirectory } from "./layout-prefixes";
import { notFoundPageHandlerOptions } from "./not-found-handler-options";
import { normalizePageModule } from "./normalize-page-module";
import { productionDeclaredStylesheetUrls, productionStylesheetUrls } from "./stylesheet-urls";
import type { RequestStylesheetUrlResolver } from "./document-stylesheet-urls";
import {
  DuplicateNotFoundPageError,
  isNotFoundPageFile,
  NotFoundPageDeclaresRouteError,
  registerNotFoundPageRoute,
} from "./not-found-page";
import type { PageManifest, PageManifestLayoutEntry, PageManifestPageEntry } from "./page-manifest";
import type { PageRouteExport } from "./page-module-shapes";
import { createRouteTranslationsResolver } from "./route-translations";

function manifestModule(entry: {
  module: Record<string, unknown>;
  sourceFile: string;
  setupModule?: Record<string, unknown>;
  setupSourceFile?: string;
}): Record<string, unknown> {
  return composePageModule(entry.module, entry.setupModule, entry.sourceFile, entry.setupSourceFile);
}

/** The exports this module reads off a layout module namespace. */
/**
 * The default export — the thing that puts an element in the document, and
 * therefore the ONLY export that decides whether a layout counts against the
 * single-rendering-layout rule (`../routing/layout-policy.ts`). The manifest
 * carries LOADED modules, so this is a fact rather than a guess, exactly as it
 * is in dev's own `LayoutModuleShape`.
 */
/** The layout's guards, in the order it declared them. */

/**
 * How a handler is built for one page. Defaults to `createPageRouteHandler`;
 * taking it as an input keeps this module's own job — reading the manifest and
 * registering routes — provable without a render pipeline behind it.
 */
export type PageRouteHandlerFactory = (options: PageRouteHandlerOptions) => PageRouteHandler;

export type InstalledManifestPageRoute = {
  /** The canonical declared route path, before layout-prefix composition. */
  declaredPath: string;
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
  /** `modulepreload` URLs for the entry's own static imports (card 53f8647e). */
  hydrationClientModulePreloadUrls?: readonly string[];
  /**
   * Where the client build wrote its output — `productionStylesheetUrls`'s own
   * `clientDir` argument, forwarded here rather than pre-read into a flat list:
   * each registered handler needs its OWN chain
   * (`[root, ...outer-to-inner matched layouts, page]`, matched by the
   * manifest's own `sourceFile` ids), not one list shared by every page.
   *
   * OPTIONAL for the same reason `PageManifest.clientDir` is: a build that
   * discovered zero pages emits no client bundle, so there is no directory to
   * read stylesheets from — and no page that could need one either.
   */
  clientDir?: string;
  /** Same helper `dev-error-transport.ts` exports — passed in, never imported. */
  createHandler?: PageRouteHandlerFactory;
};

/**
 * `sourceFile`'s path relative to the web root — `src/web/**`, the only page
 * root discovery enumerates (`discoverWebRoots`,
 * `web/src/build/discover-pages.ts:210-213`). Manifest `sourceFile`s are
 * app-root-relative (`"src/web/..."`, `page-manifest.ts`'s own doc comment),
 * so dropping the first two segments — `<srcDir>`, then the literal `"web"` —
 * recovers exactly what `deriveFilesystemRoutePath`/`deriveFilesystemRouteName`
 * expect: the same value dev computes as `install-page-routes.ts`'s
 * `filesystemPageFileFor`.
 */
function webRelativeSourceFile(sourceFile: string): string {
  return sourceFile.split("/").slice(2).join("/");
}

/**
 * Exported for `../routing/route-name-parity.spec.ts`, which proves this and
 * dev's own call agree — both now call the same `../routing/route-identity.ts`
 * `resolvePageRouteIdentity`, so this wrapper's only job is supplying THIS
 * installer's identifiers: the manifest `sourceFile` doubles as the
 * `route.path` rejection context, and its web-root-relative form is the
 * filesystem-derivation input.
 */
export function resolveRoute(
  routeExport: PageRouteExport | undefined,
  sourceFile: string,
): { path: string; name: string } {
  return resolvePageRouteIdentity(routeExport, webRelativeSourceFile(sourceFile), sourceFile);
}

/**
 * Every layout's declared `prefix`, keyed by its directory relative to the
 * web root — the same table dev builds as its own `LayoutLevel.prefixesByDirectory`,
 * and the one {@link deriveFilesystemRoutePath} uses to let a directory's own
 * layout rename the URL segment a bare directory name would otherwise
 * contribute.
 */
function layoutPrefixesOf(page: PageManifestPageEntry): Record<string, string> {
  return layoutPrefixesByDirectory(
    page.layouts.map((layout) => {
      const relative = webRelativeSourceFile(layout.sourceFile);
      const slashIndex = relative.lastIndexOf("/");
      const directory = slashIndex === -1 ? "" : relative.slice(0, slashIndex);

      return {
        directory,
        prefix: normalizePageModule(manifestModule(layout), "layout", layout.sourceFile).prefix,
      };
    }),
  );
}

/**
 * The page's layout LEVEL, resolved from the whole chain the manifest carries
 * rather than from the one layout nearest to it. The selection and prefix
 * rules themselves do not depend on where a layout's module came from, so
 * they live in one place both installers call —
 * `../routing/layout-level.ts`'s `resolveLayoutLevel` — rather than being
 * re-derived here against loaded modules instead of Vite's. This function's
 * own job is reading THIS installer's inputs off the manifest (`renders` and
 * `prefix` off each already-loaded module, `host` recovered from the shared
 * result's `hostId`) and nothing else.
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
 * before a single request can observe the wrong document (raised by the
 * shared `resolveLayoutLevel` itself). Like the missing app-root refusal
 * below, that defends against stale or hand-edited build artifacts: the build
 * refuses to emit such a chain, but a manifest can reach a running process
 * without that build having produced it.
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
  const level = resolveLayoutLevel(
    page.sourceFile,
    page.layouts.map((layout) => ({
      id: layout.sourceFile,
      renders:
        typeof normalizePageModule(manifestModule(layout), "layout", layout.sourceFile).default !==
        "undefined",
      prefix: normalizePageModule(manifestModule(layout), "layout", layout.sourceFile).prefix,
    })),
  );

  return {
    host: page.layouts.find((layout) => layout.sourceFile === level.hostId),
    prefix: level.prefix,
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
  const hostIndex = page.layouts.indexOf(host);

  return composeLayoutModules(
    page.layouts.map((layout) => normalizePageModule(manifestModule(layout), "layout", layout.sourceFile)),
    hostIndex,
    page.layouts.map((layout) => layout.sourceFile),
  );
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
    hydrationClientModulePreloadUrls,
    clientDir,
    createHandler = createPageRouteHandler,
  } = options;

  const localeFiles = manifest.localeFiles ?? [];
  const localeSourceByFile = new Map(localeFiles.map((file) => [file.sourceFile, file]));
  const manifestWebRoot =
    manifest.app === undefined ? undefined : path.dirname(manifest.app.sourceFile);
  const getRouteTranslations = createRouteTranslationsResolver(
    buildRouteLocaleManifest(
      {
        pages: [
          ...manifest.pages.map((page) => ({
            pageFile: page.sourceFile,
            webRoot: manifestWebRoot ?? path.dirname(page.sourceFile),
          })),
          ...(manifest.app === undefined
            ? []
            : [{ pageFile: manifest.app.sourceFile, webRoot: manifestWebRoot! }]),
          ...(manifest.errorPage === undefined
            ? []
            : [
                {
                  pageFile: manifest.errorPage.sourceFile,
                  webRoot: manifestWebRoot ?? path.dirname(manifest.errorPage.sourceFile),
                },
              ]),
        ],
        localeFiles: localeFiles.map(({ sourceFile, webRoot }) => ({ sourceFile, webRoot })),
      },
      {
        localeCodes: config.key<readonly string[] | undefined>("app.localeCodes"),
        localeCode: config.key<string | undefined>("app.localeCode"),
        readSource: (sourceFile) => {
          const source = localeSourceByFile.get(sourceFile);
          if (source === undefined) {
            throw new Error(
              `Route locale manifest has no serialized source for ${JSON.stringify(sourceFile)}.`,
            );
          }
          return source.source;
        },
      },
    ),
  );

  if (manifest.errorPage !== undefined) {
    const errorPage = normalizePageModule(
      manifestModule(manifest.errorPage),
      "page",
      manifest.errorPage.sourceFile,
    );

    if (errorPage.route !== undefined) {
      throw new ErrorPageDeclaresRouteError(manifest.errorPage.sourceFile);
    }
  }

  if (manifest.pages.length === 0) return [];

  // Resolved once, up front — the same value dev resolves in
  // `../install-page-routes.ts`, so a page's registrations cannot disagree
  // between dev and production.
  const localeRouting = resolveLocaleRouting();

  // Per-request `linkStylesheetsFor()` declarations, resolved against the same
  // client manifest the chains above read. Memoised per declared set: the
  // manifest is immutable for the life of a production process.
  const declaredStylesheetUrls = new Map<string, readonly string[]>();
  const resolveRequestStylesheetUrls: RequestStylesheetUrlResolver = (sourceFiles) => {
    const key = sourceFiles.join("\n");
    const cached = declaredStylesheetUrls.get(key);

    if (cached !== undefined) return cached;

    const urls = productionDeclaredStylesheetUrls(clientDir ?? "", sourceFiles);

    declaredStylesheetUrls.set(key, urls);

    return urls;
  };

  const app = manifest.app;

  if (app === undefined) {
    throw new Error(
      `installPageRoutesFromManifest: this build's page manifest carries ${manifest.pages.length} ` +
        "page(s) but no application root. Every page renders inside the app component, so no " +
        "page can be registered without it. Re-run the build so the generated pages barrel " +
        "provides an `app` entry.",
    );
  }

  normalizePageModule(manifestModule(app), "root", app.sourceFile);

  // Ids are the manifest's own `sourceFile` strings and are passed on untouched:
  // the loader below matches them by exact string equality, so resolving,
  // joining or swapping separators on one side of that comparison would turn
  // every lookup into a miss.
  const loadModule = createPageModuleLoader(manifest);
  // The namespace is already statically imported by the generated barrel, but
  // do not hand it to the render pipeline until a request actually fails.
  const loadErrorPage =
    manifest.errorPage === undefined
      ? undefined
      : async () => manifestModule(manifest.errorPage!) as ErrorPageModule;

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

  if (
    notFoundPage !== undefined &&
    normalizePageModule(manifestModule(notFoundPage), "page", notFoundPage.sourceFile).route !== undefined
  ) {
    throw new NotFoundPageDeclaresRouteError(notFoundPage.sourceFile);
  }

  // Built ONCE, before the loop, and shared: the catch-all below renders it
  // for an unmatched URL, and every page reaches it through `renderNotFound`
  // for a loader `notFound()`. A production manifest never changes under a
  // running process, so the getter always returns this one handler.
  const notFoundPageHandler =
    notFoundPage === undefined
      ? undefined
      : createHandler(
          notFoundPageHandlerOptions({
            appFile: app.sourceFile,
            pageFile: notFoundPage.sourceFile,
            loadModule,
            hydrationClientModuleUrl,
            hydrationClientModulePreloadUrls,
            loadErrorPage,
            errorPageFile: manifest.errorPage?.sourceFile,
            getRouteTranslations,
            // NO LAYOUT means no layout CSS either — just root and the
            // not-found page's own stylesheets, same reasoning as the
            // shared helper's own header comment.
            stylesheetUrls:
              clientDir === undefined
                ? []
                : productionStylesheetUrls(clientDir, [app.sourceFile, notFoundPage.sourceFile]),
            resolveRequestStylesheetUrls,
          }),
        );
  const renderNotFound = () => notFoundPageHandler;

  const installed: InstalledManifestPageRoute[] = [];
  const fileByPath = new Map<string, string>();

  for (const page of pages) {
    const { host: layout, prefix: layoutPrefix } = layoutLevelOf(page);
    const pageModule = normalizePageModule(manifestModule(page), "page", page.sourceFile);
    const routeExport = pageModule.route;

    const { path: routePath, name } = resolveRoute(routeExport, page.sourceFile);

    // Validated at INSTALL time — the same boot-time gate dev applies in its
    // own installer — so a malformed `cache` opt-in fails a production boot
    // instead of shipping a page whose freshness window the framework
    // silently guessed.
    const cache = pageModule.cache;

    // Explicit wins; otherwise the path is derived from the page's own source
    // location and the layouts on its path — the same rule dev applies at
    // registration and discovery applies at build (`discover-pages.ts`), read
    // here off the manifest's own `sourceFile`s instead of the filesystem.
    const effectivePath =
      routeExport === undefined
        ? deriveFilesystemRoutePath({
            pageFile: webRelativeSourceFile(page.sourceFile),
            layoutPrefixes: layoutPrefixesOf(page),
          })
        : composeRoutePath(layoutPrefix, routePath);
    const existingFile = fileByPath.get(effectivePath);

    if (existingFile) {
      throw new Error(
        duplicateRoutePathMessage({
          effectivePath,
          existingFile,
          newFile: page.sourceFile,
          composition: { layoutPrefix, routePath },
        }),
      );
    }

    fileByPath.set(effectivePath, page.sourceFile);

    // The layout slot's id resolves to the COMPOSED level — every layout's
    // middleware, in chain order — and every other id goes straight to the
    // manifest lookup. Composition also validates a single layout's static
    // metadata before its module reaches the render pipeline.
    const composedLayout = layout !== undefined ? composeLayoutLevel(page, layout) : undefined;

    // Every registered handler gets ITS OWN immutable, ordered, deduped CSS
    // chain: root, then every matched layout outer to inner (`page.layouts`,
    // the manifest's own chain — the same one dev walks as
    // `layoutLevel.chain`), then the page. `PageManifest.clientDir` is present
    // whenever `pages` is non-empty (`page-manifest.ts`), which this loop only
    // ever reaches when it is — `clientDir === undefined` is handled anyway,
    // rather than trusted away, because a caller can still pass this function
    // a manifest that violates its own generator's invariant.
    const stylesheetUrls =
      clientDir === undefined
        ? []
        : productionStylesheetUrls(clientDir, [
            app.sourceFile,
            ...page.layouts.map((pageLayout) => pageLayout.sourceFile),
            page.sourceFile,
          ]);

    const pageHandler = createHandler({
      path: effectivePath,
      name,
      appFile: app.sourceFile,
      pageFile: page.sourceFile,
      layoutFile: layout?.sourceFile,
      loadModule: loadModule,
      loadComposedLayout:
        composedLayout === undefined ? undefined : () => Promise.resolve(composedLayout),
      loadRegistrationLayouts: () => Promise.resolve(page.layouts.map((layout) => manifestModule(layout))),
      hydrationClientModuleUrl,
      hydrationClientModulePreloadUrls,
      loadErrorPage,
      errorPageFile: manifest.errorPage?.sourceFile,
      getRouteTranslations,
      stylesheetUrls,
      resolveRequestStylesheetUrls,
      cache,
      renderNotFound,
    });

    // Under an active `web.localeRouting.strategy` this is more than one
    // registration — the base path (possibly rewritten into a locale
    // redirect) plus one literal path per prefixed code, mirroring
    // `../install-page-routes.ts` exactly (`./locale-routing/locale-page-registrations.ts`).
    // Under `"none"` it is exactly the base registration, unchanged.
    for (const registration of localePageRegistrations(
      effectivePath,
      name,
      pageHandler,
      localeRouting,
      { pageFile: page.sourceFile, renderNotFound },
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

    installed.push({
      declaredPath: routePath,
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
  registerNotFoundPageRoute({ router, renderPage: notFoundPageHandler });
  // `isPage` for the same reason the dev installer carries it — the router's
  // duplicate-name error reads the flag to say which claimant is the page.

  /*
    Same publish as the dev installer, for the same reason: `href()` and the
    router must agree, and they only can if both read the one loop that
    registered the routes. Production installs once at boot, so the wholesale
    replacement is a single write before the first request.
  */
  publishRouteTable(installed, "installPageRoutesFromManifest (production)");
  publishLocaleRouting(localeRouting);

  return installed;
}
