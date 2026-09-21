/**
 * The page handler, as a named seam.
 *
 * This is the request handler `installPageRoutes` used to inline into its
 * `router.get(...)` call (`install-page-routes.ts:236-275` before this
 * extraction; the pre-extraction copy is `scratchpad/install-page-routes.ts.orig`).
 * The behaviour is unchanged, byte for byte — what changes is that it is now
 * a named, exported, independently constructible function instead of a closure
 * over eight ambient bindings of `installPageRoutes`.
 *
 * WHY IT TAKES `loadModule` AND NOT A `ViteDevServer`: loading a module is the
 * only capability the handler ever needed, and the two runtimes answer it
 * differently — dev goes through Vite's SSR graph
 * (`vite.ssrLoadModule`, `install-page-routes.ts:207`), production reads the
 * already-built page manifest (`page-manifest.ts`). Taking "how to load a
 * module" as an INPUT is what lets the same handler serve both, and what lets
 * a test construct it with a plain async function — no Vite, no dev server, no
 * `app/` directory on disk.
 *
 * Scope: this file creates a seam and nothing else. It does not implement
 * `type: "page"` routing, HTML error pages, or any other new capability.
 */
import {
  buildTracingContext,
  container,
  dispatchPhase,
  isTracingEnabled,
  Response,
  type FastifyInstance,
  type HttpContext,
  type Request,
} from "@warlock.js/core";

import { isDataRequest, WARLOCK_DATA_REQUEST_HEADER } from "../routing/data-request";
import { isCrawlerRequest } from "./detect-crawler";
import { registerModules, type RegisterableModuleNamespace } from "../register-modules";
import { applyResponseCacheFloor } from "./response-cache-floor";
import type { PageCacheOptIn } from "../routing/route-identity";
import type { RequestStylesheetUrlResolver } from "./document-stylesheet-urls";
import { resolveAuthCookieName } from "./auth-cookie-name";
import { frameworkDefaultNotFoundDocument } from "./not-found-page";
import { looksAuthenticated } from "./page-cache-eligibility";
import { hasCookieRequiringPageCacheBypass } from "./page-cache-cookie-bypass";
import { type PageCacheVariant } from "./page-cache-key";
import { pageVaryHeader } from "./page-vary-header";
import { reportServerError } from "./report-server-error";
import { pathnameFromRequest } from "./error-reporting-config";
import { ensureSetCookieCacheFloorHook, markPageResponse } from "./set-cookie-cache-floor-hook";
import type { BufferedCookie, PageRouteEntry, PageTripleModule } from "./execute-page-request";
import { renderPageRequest } from "./render-page";
import { NDJSON_CONTENT_TYPE } from "./write-deferred-ndjson-response";
import { applyCommit } from "./page-route-handler/apply-commit";
import { resolvePageCacheHitOrMiss } from "./page-route-handler/serve-page-cache-hit";
import { storePageCacheAfterRender } from "./page-route-handler/store-page-cache-after-render";
import { sendPageDataResponse } from "./page-route-handler/send-page-data-response";
import { writePageFailureResponse } from "./page-route-handler/write-page-failure-response";
import { normalizePageModule } from "./normalize-page-module";

declare module "@warlock.js/core" {
  interface RequestLocals {
    /**
     * Set by this file's route handler, on every page-route response
     * (document and data representations alike) — never inferred from URL
     * shape or content-type. `set-cookie-cache-floor-hook.ts`'s `onSend` hook
     * reads this to scope its effect to page responses only.
     */
    isPageResponse?: boolean;
  }
}
import type { ErrorPageModuleLoader } from "./error-page";

/**
 * Raised when a page route handler is constructed WITHOUT an `httpServer`
 * option AND the framework container has no `"http.server"` binding either —
 * i.e. there is no way, deliberate or ambient, to register the `Set-Cookie`
 * cache-floor hook. `container.get("http.server")` (`core/src/container/index.ts`)
 * is a bare `Map.get` that TypeScript types as always returning a
 * `FastifyInstance`, so a silently-missing binding used to read as "no
 * server" and skip the hook with no signal at all. This throws instead of
 * repeating that mistake. To fix: register `http.server` in the container
 * before this factory runs (the ordinary `HttpConnector.boot()` path), or —
 * if this handler genuinely has no server on purpose, such as a unit test —
 * pass `httpServer: undefined` explicitly to say so.
 */
export class MissingHttpServerForPageRouteError extends Error {
  public constructor() {
    super(
      'createPageRouteHandler: no "httpServer" option was supplied and the container has no ' +
        '"http.server" binding, so the Set-Cookie cache-floor hook on page responses cannot be ' +
        "registered. Register `http.server` in the container before this factory runs, or pass " +
        "`httpServer: undefined` explicitly if this handler is meant to have no server.",
    );
    this.name = "MissingHttpServerForPageRouteError";
  }
}

/**
 * Replay ONE committed cookie through core's own `Response.cookie()` — the
 * same serializer every ordinary controller's cookie goes through, so there
 * is nothing here for a second implementation to drift from. Passed in
 * (`applyBufferedCookie` option, below) rather than imported at the call site
 * so this file stays free of anything Vite-shaped. Exported for tests: this
 * is the only production implementation of the cookie commit.
 */
export function defaultApplyBufferedCookie(response: Response, cookie: BufferedCookie): void {
  response.cookie(cookie.name, cookie.value as never, cookie.options ?? {});
}

/**
 * How the handler obtains a page/layout/app module, by the same id
 * (`appFile`/`layoutFile`/`pageFile`) the caller registered it under. In dev
 * this is `moduleId => vite.ssrLoadModule(moduleId)`; the connector already
 * owns the dev/prod split, so the handler never learns which one it got.
 */
export type PageModuleLoader = (moduleId: string) => Promise<unknown>;

export type PageRouteHandlerOptions = {
  /** The composed, registered route path — `composeRoutePath`'s output. */
  path: string;
  /** The resolved route name; shared namespace with API routes. */
  name: string;
  /** The single global app-root file, e.g. `<appSrcRoot>/web/root.tsx`. */
  appFile: string;
  /** The page module's id. */
  pageFile: string;
  /** The page's own-directory `layout.tsx`, when it has one. */
  layoutFile?: string | undefined;
  loadModule: PageModuleLoader;
  /**
   * The already-normalized layout pipeline view. Installers supply this only
   * when several raw layout namespaces were composed into one slot; it must
   * not be normalized again because it is not an application module namespace.
   */
  loadComposedLayout?: () => Promise<PageTripleModule>;
  /** Optional lazy application `error.page.tsx` loader. Never called on success. */
  loadErrorPage?: ErrorPageModuleLoader;
  /**
   * Load the REAL layout module namespaces, outermost first, for universal
   * registration. This stays separate from `loadModule(layoutFile)` because
   * dev may answer that id with a synthetic wrapper whose middleware is the
   * composition of several layouts. That wrapper is a render-pipeline detail,
   * not a module identity, and must never enter `registerModules`' WeakSet.
   */
  loadRegistrationLayouts?: () => Promise<readonly RegisterableModuleNamespace[]>;
  /** Browser module appended after the server-rendered document. */
  hydrationClientModuleUrl?: string;
  /** `modulepreload` URLs for the entry's own static imports (card 53f8647e). */
  hydrationClientModulePreloadUrls?: readonly string[];
  /**
   * Stylesheet URLs for this page, emitted into `<head>` so the FIRST paint is
   * styled. Absent or empty means the application has no CSS — it never means
   * a stylesheet failed to resolve, which is the build's job to report.
   */
  stylesheetUrls?: readonly string[];
  /**
   * Resolves the source modules a request declared through
   * `linkStylesheetsFor()` into stylesheet URLs — the installer's dev
   * (module graph) or production (Vite manifest) answer.
   */
  resolveRequestStylesheetUrls?: RequestStylesheetUrlResolver;
  /** Same helper `dev-error-transport.ts` exports — passed in, never imported. */
  /**
   * The pattern stage 1 matches `request.path` against, when it differs from
   * the REGISTERED path. Defaults to `path`, which is right for every route
   * whose URL is its own.
   *
   * Exactly one route needs it: the not-found page, registered on the catch-all
   * `*`. `matchRoute` compares segment by segment (`./match-page-route.ts`) and
   * has no wildcard token, so a route registered as `*` matches NOTHING — the
   * pipeline reports no match and `renderPageRequest` answers `{ html: "",
   * status: 404 }`. Correct status, empty document: a 404 page that never
   * renders its own body. Handing it `requestPath => requestPath` makes the
   * requested URL the route's pattern for that one request, so the match is
   * trivially true and the page renders for the URL the visitor actually asked
   * for.
   */
  matchPath?: (requestPath: string) => string;
  /**
   * The status this route answers with when the pipeline settles on a plain
   * `200` — the not-found route's `404`, and nothing else uses it.
   *
   * Applied ONLY to `200`, never as a blanket override: a `200` from this
   * pipeline means "the document rendered and nobody objected", which for this
   * route is precisely the not-found case. Any other settled status is a real
   * outcome that the page or the boundary decided — a 500 from a failed render,
   * a redirect — and overwriting it would report a broken page as a missing one.
   */
  statusForRenderedOk?: number;
  /**
   * Exclude the page module's loader from the request triple while preserving
   * the real namespace for `register()` and rendering. Used only by the
   * catch-all 404 page: a missing URL must not run application data work or
   * turn a simple miss into a second failure path.
   */
  skipPageLoader?: boolean;
  /**
   * Forces `robots: "noindex"` onto the rendered document — see
   * `RenderPageRequestOptions.noindex`. Set only by
   * `notFoundPageHandlerOptions`.
   */
  noindex?: boolean;
  /**
   * The not-found route's OWN page handler (`notFoundPageHandlerOptions` →
   * `createPageRouteHandler`), which a FULL-DOCUMENT request hands itself to
   * when a page, layout or app loader answers `response.notFound()`. The
   * visitor then gets the exact document an unmatched URL gets — the
   * application's `404.page.tsx`, its stylesheets and head, status 404 — not a
   * second rendering of it built here.
   *
   * A getter, read per request, so dev hands over whatever not-found handler
   * its CURRENT install built — adding or deleting `404.page.tsx` is picked
   * up with the rest of the route graph. Production's getter returns the one
   * handler it built at boot.
   *
   * Absent, or returning `undefined` when the application ships no
   * `404.page.tsx`: the loader `notFound()` then answers with the framework
   * fallback (`frameworkDefaultNotFoundDocument`), again exactly as the
   * unmatched route does. Never consulted for a data request, whose 404 wire
   * is the client's cue to load the URL in full.
   */
  renderNotFound?: () => PageRouteHandler | undefined;
  /**
   * Replays one committed cookie through core's `Response.cookie()`. Defaults
   * to doing exactly that (`defaultApplyBufferedCookie`, above); injectable so
   * a caller with a different `Response` shape (or a test) can observe/replace
   * the call.
   */
  applyBufferedCookie?: (response: Response, cookie: BufferedCookie) => void;
  /**
   * The Fastify instance to register the `Set-Cookie` cache-floor `onSend`
   * hook on (`ensureSetCookieCacheFloorHook`, `set-cookie-cache-floor-hook.ts`).
   * Defaults to `container.get("http.server")` — the same instance
   * `HttpConnector` publishes during its own `boot()`, which runs before
   * `WebConnector.boot()` calls this factory. Injectable so a test can hand
   * this factory a self-contained Fastify instance it built and booted
   * itself, with no framework connector graph involved.
   */
  httpServer?: FastifyInstance;
  /**
   * This route's resolved `cache` opt-in, already validated
   * ({@link resolvePageRouteCache}) by whichever installer (dev's
   * `install-page-routes.ts` or production's
   * `install-page-routes-from-manifest.ts`) built these options — `undefined`
   * means the route declared no `cache` at all. Read by
   * `applyResponseCacheFloor` (`response-cache-floor.ts`) at the same seam
   * that applies the `Set-Cookie`/auth-derived floor, so the document and the
   * data representation can never disagree on `Cache-Control`.
   */
  cache?: PageCacheOptIn;
};

export type PageRouteHandler = (context: HttpContext) => Promise<void | Response>;

/**
 * Build the handler for ONE page route. Per request it loads the App + layout
 * + page triple (concurrently, in that order), renders the URL through
 * `renderPageRequest`, splices in the hydration module, and flushes the
 * document.
 *
 * No try/catch, deliberately: loader/render throws are already absorbed by the
 * pipeline's boundary machinery inside `renderPageRequest`, and anything that
 * escapes (a module-load or register failure, the missing-`</body>` throw
 * above) belongs to the router's error path — which is exactly where it went
 * before.
 */
export function createPageRouteHandler(options: PageRouteHandlerOptions): PageRouteHandler {
  const {
    path,
    name,
    appFile,
    pageFile,
    layoutFile,
    loadModule,
    loadComposedLayout,
    loadErrorPage,
    loadRegistrationLayouts,
    hydrationClientModuleUrl,
    hydrationClientModulePreloadUrls,
    stylesheetUrls,
    resolveRequestStylesheetUrls,
    matchPath,
    statusForRenderedOk,
    skipPageLoader = false,
    noindex = false,
    renderNotFound,
    applyBufferedCookie = defaultApplyBufferedCookie,
    cache,
  } = options;

  // Distinguish "not supplied" (fall back to the container, and REQUIRE the
  // container to have it) from "supplied as `undefined`" (a deliberate "this
  // handler has no server" — the escape hatch unit tests use). Collapsing
  // both into one optional-with-a-default, as this used to, let a genuinely
  // missing `http.server` container binding masquerade as the deliberate
  // no-server case with no signal at all — see `MissingHttpServerForPageRouteError`.
  let httpServer: FastifyInstance | undefined;

  if ("httpServer" in options) {
    httpServer = options.httpServer;
  } else if (container.has("http.server")) {
    httpServer = container.get("http.server");
  } else {
    throw new MissingHttpServerForPageRouteError();
  }

  // Registration-time, not request-time: this runs once per page route, while
  // `WebConnector.boot()` installs routes — after `HttpConnector.boot()` has
  // already registered `@fastify/cookie` (`set-cookie-cache-floor-hook.ts`
  // explains why that ordering is what makes the hook able to see the
  // header). `httpServer` is `undefined` here only when it was supplied that
  // way explicitly (checked above) — nothing to register the hook on, and
  // nothing that will ever mark a request as a page response either, so
  // skipping is correct, not just safe.
  if (httpServer) {
    ensureSetCookieCacheFloorHook(httpServer);
  }

  return async (context: HttpContext) => {
    const { request, response } = context;

    const wantsData = isDataRequest(request.header(WARLOCK_DATA_REQUEST_HEADER, undefined));

    // Stage 2 slice S3 (contract rule 10): a client navigation that can read
    // the streaming representation says so via `Accept`. Presence-checked
    // exactly like `isDataRequest` above — a proxy or an older client that
    // never mentions it gets the fully-awaited JSON, never a body it did not
    // ask to read incrementally.
    const acceptHeader = String(request.header("accept", "") ?? "");
    const wantsNdjson = wantsData && acceptHeader.includes(NDJSON_CONTENT_TYPE);

    // Crawler mode (Stage 1 point 6): only meaningful for a FULL-DOCUMENT
    // request — a data request already fully awaits and inlines deferred
    // values by default (`awaitDeferredForDataRequest` above), so detection
    // never runs for one. `isCrawlerRequest` itself is the single source of
    // truth for `web.streaming.crawlers`'s three shapes (off, custom,
    // built-in default) — see `detect-crawler.ts`.
    const crawler = !wantsData && isCrawlerRequest(request);

    // Server-side page cache (`route.cache.serverCache`,
    // `../routing/route-identity.ts`'s `PageCacheOptIn`). Every check below is
    // gated on this one flag so a route WITHOUT `serverCache` is completely
    // untouched: no header, no cache module ever loaded, no behaviour change.
    const pageCacheVariant: PageCacheVariant = wantsData ? "json" : "html";

    // Decided BEFORE the loader and before any cache lookup (lead decision
    // 4): a request carrying a credential must never be served a guest page
    // from the cache, and this check is cheap — a header/cookie read, no JWT
    // verification, no loader execution — exactly like `looksAuthenticated`'s
    // own doc comment describes.
    //
    // SECURITY FIX, card ad861076 (5.17): ORed with
    // `hasCookieRequiringPageCacheBypass`, which does not depend on
    // `auth.cookie.name` at all — it bypasses on ANY cookie other than the
    // framework's locale cookie, so a session cookie under an app-specific
    // name (never recognized by `looksAuthenticated`) still forces a bypass
    // instead of being cached and replayed to the next anonymous visitor.
    //
    // Computed for every GET to an opted-in route, not only when
    // `serverCache` is on: `applyResponseCacheFloor` below reuses this SAME
    // result to decide `Cache-Control`, so a route with `cache.public` but no
    // `serverCache` gets the same protection against a loader that
    // authenticates straight from the cookie/header without ever touching
    // `request.locals.authDerived` (`response-cache-floor.ts`).
    const requestLooksAuthenticated =
      cache !== undefined && request.method === "GET"
        ? looksAuthenticated(request, resolveAuthCookieName()) ||
          hasCookieRequiringPageCacheBypass(request)
        : false;

    const credentialedRequest = cache?.serverCache === true ? requestLooksAuthenticated : false;

    let cacheHeaderValue: "hit" | "miss" | "bypass" | undefined;
    let cacheKey: string | undefined;
    let attemptStorageAfterRender = false;

    try {
      if (cache?.serverCache === true) {
        const outcome = await resolvePageCacheHitOrMiss({
          request,
          response,
          cache,
          credentialedRequest,
          pageCacheVariant,
        });

        if (outcome.served) return;

        cacheHeaderValue = outcome.cacheHeaderValue;
        cacheKey = outcome.cacheKey;
        attemptStorageAfterRender = outcome.attemptStorageAfterRender;
      }

      const [rawAppModule, layoutModule, rawPageModule, registrationLayouts] = await Promise.all([
        loadModule(appFile),
        layoutFile
          ? (loadComposedLayout?.() ??
            loadModule(layoutFile).then((module) =>
              normalizePageModule(module, "layout", layoutFile),
            ))
          : Promise.resolve({}),
        loadModule(pageFile),
        loadRegistrationLayouts?.() ?? Promise.resolve([]),
      ]);

      // Refuse invalid live app/page namespaces before their registration hooks
      // can run. Registration itself still receives the original namespaces so
      // its WeakSet continues to track HMR replacement identities.
      const appModule = normalizePageModule(rawAppModule, "root", appFile);
      const pageModule = normalizePageModule(rawPageModule, "page", pageFile);

      // Registration is the first lifecycle action after all module namespaces
      // have loaded and before `renderPageRequest` can run middleware, loaders or
      // render. Layouts deliberately come from the separate raw chain above,
      // never from `layoutModule`, which may be the synthetic composed middleware
      // wrapper used by dev.
      registerModules([
        rawAppModule as RegisterableModuleNamespace,
        ...registrationLayouts,
        rawPageModule as RegisterableModuleNamespace,
      ]);

      const triple: PageRouteEntry["triple"] = {
        app: appModule,
        layout: layoutModule as PageTripleModule,
        // Registration above deliberately receives the REAL namespace. Only the
        // pipeline view is projected: spreading preserves the component,
        // metadata, middleware and boundary exports while making a custom 404's
        // loader uncallable.
        page: skipPageLoader
          ? {
              ...pageModule,
              // Vite and native ESM loaders hand us module namespace objects,
              // whose export descriptors are not an object-spread contract.
              // Keep the rendering export explicitly while hiding only loader.
              default: pageModule.default,
              loader: undefined,
            }
          : pageModule,
      };

      const requestUrl = request.path;
      // `String.split` always returns at least one element — the default only
      // narrows `noUncheckedIndexedAccess`'s `string | undefined` away, it
      // never actually applies at runtime.
      const [requestPathname = requestUrl] = requestUrl.split("?");
      const entry: PageRouteEntry = {
        path: matchPath === undefined ? path : matchPath(requestPathname),
        name,
        triple,
        layoutPath: layoutFile,
      };

      // Core selected this handler before it constructed the HTTP context and
      // decoded dynamic segments into `request.params`. Passing that result
      // through makes core the sole matcher on the live path. The catch-all
      // page deliberately has no wildcard param: its virtual path is the
      // missed URL itself, so it remains the named `not-found` route with `{}`.
      const params = matchPath === undefined ? (request.params as Record<string, string>) : {};

      // A DATA request runs everything above and below this line identically —
      // it is the same route, the same match and the same pipeline — and differs
      // only in what gets written at the end. Decided here, before the render, so
      // the branch is visibly about REPRESENTATION and not about behaviour.
      const rendered = await renderPageRequest(requestUrl, {
        routes: [entry],
        matched: { entry, params },
        createHttp: () => ({ request, response }),
        loadErrorPage,
        dataRequest: wantsData,
        // Stage 2 slice S3: a plain data request (no `x-ndjson` in `Accept`)
        // awaits every deferred settlement and inlines it — the NDJSON
        // request keeps `deferredKeys`/`deferredSettlements` on the bundle
        // for this handler to stream itself, below.
        //
        // `attemptStorageAfterRender` forces the SAME await-and-inline path a
        // data request already has, even for an NDJSON request
        // (`wantsNdjson`): a serverCache-eligible route never streams NDJSON
        // on a miss, it stores (and serves) the fully-resolved JSON variant
        // instead — see `page-cache-store.ts`.
        awaitDeferredForDataRequest: attemptStorageAfterRender
          ? wantsData
          : wantsData && !wantsNdjson,
        stylesheetUrls,
        resolveRequestStylesheetUrls,
        hydrationClientModuleUrl,
        hydrationClientModulePreloadUrls,
        // A detected crawler forces `onAllReady` on its own (`render-page.ts`'s
        // `finishRender`) — `waitForAll` here stays `false` for every request
        // this handler serves; nothing else in this framework needs it set.
        waitForAll: false,
        // Forcing `crawler: true` for a serverCache miss on the document
        // representation reuses the exact await-and-inline path a REAL
        // crawler gets (`render-page.ts`), so the stored/served bytes are
        // always the fully resolved document — never a shell with deferred
        // chunks a HIT would have no live stream to append to.
        crawler: attemptStorageAfterRender && !wantsData ? true : crawler,
        noindex,
      });

      if (rendered instanceof Response) return rendered;

      const shortCircuit = rendered.bundle?.shortCircuit;

      // A page/layout middleware that already SENT the reply itself (a
      // `pageAuth` redirect, `response.forbidden()`) is the whole answer, for
      // the document and the data representation alike. Anything written
      // after it — a data payload, the empty buffered document, a page-cache
      // entry — would only trip core's already-sent guard and log a
      // middleware bug that is not there.
      if (shortCircuit?.stage === "middleware" && shortCircuit.responseSent) return;

      // See `statusForRenderedOk`: a settled 200 is the only status this route is
      // allowed to restate, and both the document and the data branch below must
      // restate it the same way — a client navigation that received 200 with a
      // not-found payload would push the URL into history as a real page.
      const status =
        rendered.status === 200 && statusForRenderedOk !== undefined
          ? statusForRenderedOk
          : rendered.status;

      // Stage 10a: the stage 7 commit (headers, then cookies), applied ONCE,
      // identically for the document and the data representation — see
      // `applyCommit`.
      applyCommit(response, rendered, applyBufferedCookie);

      // Marks this request for `set-cookie-cache-floor-hook.ts`'s `onSend`
      // hook, which runs LATER than this seam — after `@fastify/cookie` has
      // flushed a parked `setCookie()`/`clearCookie()` call onto the real
      // header. Must happen before either terminal write below, same as
      // `applyResponseCacheFloor` just below it.
      markPageResponse(request);

      // `request.locals.authDerived` (core `Request`) is set the moment `user`
      // or `decodedAccessToken` is assigned, and never cleared. Overriding
      // `Cache-Control` here — after `applyCommit`'s default `private` and
      // before EITHER terminal write below — closes two gaps `private` alone
      // leaves open: a browser (not a shared cache; `private` already stops
      // those) holding an authenticated page in its own disk/back-forward
      // cache with no freshness directive, AND a `Set-Cookie` response held in
      // a shared cache handing the same cookie to every later visitor
      // (session fixation — see `response-cache-floor.ts`). Read once,
      // applied identically to both representations, so neither can carry a
      // weaker header than the other.
      //
      // TRI-STATE, deliberately, not `=== true`: several existing unit tests
      // hand this handler a plain `{ path, header }` mock with no `locals` at
      // all, never a real core `Request` — that is the auth mark mechanism
      // being genuinely UNOBSERVABLE on this request, not the mechanism
      // having fired `false`. Collapsing both into one boolean via
      // `request.locals?.authDerived === true` used to read "unobservable" as
      // "provably clean", which let an opted-in route serve `public,
      // max-age=N` to a request nobody could actually vouch for. The ruling
      // for the per-route cache opt-in is fail-CLOSED — unproven means
      // revoked — so `undefined` is passed through as its own state here and
      // it is `applyResponseCacheFloor` (`response-cache-floor.ts`) that
      // decides what each of the three states does to the opt-in; this seam
      // only reports what it actually knows.
      const authDerivedState =
        request.locals === undefined ? undefined : request.locals.authDerived === true;

      // A loader `notFound()` on a FULL-DOCUMENT request answers with the
      // not-found route's own document — the one an unmatched URL gets —
      // instead of the empty body `finishRender` leaves for every loader
      // short-circuit. Delegated rather than rendered here so the 404 page's
      // composition, stylesheets, head and `Cache-Control` have exactly one
      // implementation. Decided before this route's cache floor: a 404 must
      // never inherit a `public, max-age` opt-in, and the delegated handler
      // applies its own. The data wire is untouched — its 404 is what sends
      // the client to a full load of this same URL.
      if (!wantsData && shortCircuit?.stage === "loaders" && shortCircuit.kind === "notFound") {
        const notFoundHandler = renderNotFound?.();

        if (notFoundHandler !== undefined) return notFoundHandler(context);

        applyResponseCacheFloor(response, {
          authDerived: authDerivedState,
          requestLooksAuthenticated,
        });

        await response.html(frameworkDefaultNotFoundDocument(request.locale), 404);

        return;
      }

      applyResponseCacheFloor(response, {
        authDerived: authDerivedState,
        cache,
        requestLooksAuthenticated,
      });

      // Emitted at the SAME seam as the floor, right after it, so the two
      // headers can never be computed from different auth-state reads.
      // Absent entirely for a route without `serverCache`.
      if (cacheHeaderValue !== undefined) {
        response.header("x-warlock-cache", cacheHeaderValue);
      }

      // ONE `header()` call for the whole response, HTML and JSON alike —
      // see `pageVaryHeader`'s doc comment on why a second `header("Vary",
      // ...)` call further down (the old per-branch calls this replaces)
      // would silently overwrite this one instead of combining with it. A
      // route with no `cache` opt-in and no `defer()` gets no `Vary` at all,
      // same as before this fix.
      const varyHeader = pageVaryHeader({
        dataRepresentation: wantsData,
        cacheOptedIn: cache !== undefined,
        deferred: rendered.usesDefer ?? false,
      });

      if (varyHeader !== undefined) {
        response.header("Vary", varyHeader);
      }

      // Store-time eligibility (lead decision 3) and the write itself, when
      // applicable — see `store-page-cache-after-render.ts`. Its result feeds
      // both the `wantsData` branch below (`precomputedJsonBody`, so the
      // response never re-serializes the same bundle) and the streaming send
      // further down (`documentPipeableStreamForSend`/`pendingPageCacheWrite`,
      // so `tapPipeableStreamForPageCacheLimit`'s tap sees every byte as it
      // flows to the visitor).
      const cacheStorageAttempt =
        attemptStorageAfterRender && cacheKey !== undefined && cache !== undefined
          ? await storePageCacheAfterRender({
              request,
              response,
              cache,
              cacheKey,
              authDerivedState,
              status,
              crawler,
              rendered,
              pageCacheVariant,
            })
          : undefined;

      const { documentPipeableStreamForSend, pendingPageCacheWrite, precomputedJsonBody } =
        cacheStorageAttempt ?? {
          documentPipeableStreamForSend: undefined,
          pendingPageCacheWrite: undefined,
          precomputedJsonBody: undefined,
        };

      if (wantsData) {
        await sendPageDataResponse({
          request,
          response,
          rendered,
          status,
          wantsNdjson,
          precomputedJsonBody,
        });

        return;
      }

      // Rule 4 (`User-Agent` when deferred) is already folded into the single
      // `Vary` set above, alongside `wantsData`'s JSON case — see the call
      // site right after the `x-warlock-cache` header.

      // A page middleware that returned 2xx content without writing the reply
      // replaces the page: its value is the body, so there is no document to
      // decorate with stylesheets or the hydration module.
      if (shortCircuit?.stage === "middleware" && !shortCircuit.responseSent && status < 400) {
        if (typeof shortCircuit.value !== "string") {
          response.setContentType("application/json; charset=utf-8");
        }

        await response.send(rendered.html, status);

        return;
      }

      // Stylesheets and the hydration client module both render THROUGH React
      // now (`<Head/>`/`<Scripts/>`, fed by `DocumentContext` —
      // `stylesheetUrls`/`hydrationClientModuleUrl` above), so `rendered.html`
      // and `rendered.pipeableStream` already carry them; there is nothing
      // left for this seam to splice.
      //
      // `pipeableStream` is how every real document render reaches this
      // point (`finishRender`'s stage 9) — this handler never touches
      // `response.raw` itself, only `Response.streamReact`, which does. The
      // buffered fallback below exists for a `renderPageRequest` result that
      // is not a genuine document render (a non-standard caller, or a test
      // double) and stays a plain, unspliced send.
      //
      // A store-eligible MISS streams from `documentPipeableStreamForSend`
      // (the live half of `tapPipeableStreamForPageCacheLimit`'s tap) instead
      // of `rendered.pipeableStream` directly — the visitor gets every byte
      // either way; only the SEPARATE, capped copy handed to the page cache
      // can be dropped once it crosses `maxEntryBytes`. The cache write
      // itself only happens once this stream has fully drained, so it always
      // knows the copy's final size.
      if (documentPipeableStreamForSend !== undefined) {
        response.setContentType("text/html");
        response.setStatusCode(status);

        await response.streamReact(documentPipeableStreamForSend);
        await pendingPageCacheWrite?.();

        return;
      }

      if (rendered.pipeableStream) {
        response.setContentType("text/html");
        response.setStatusCode(status);

        // "stream.end" tracing phase: the whole `streamReact`
        // await, which resolves only once the raw response has finished
        // sending — including every deferred settlement's chunk, since
        // `wrapPipeableStreamForDeferredEmission` (`defer-emission.ts`) does
        // not end the destination until the last one has settled AND React's
        // own `onAllReady` has fired. One boolean check, no timer, when
        // tracing is disabled.
        const tracingEnabled = isTracingEnabled();
        const streamEndStartedAt = tracingEnabled ? performance.now() : 0;

        await response.streamReact(rendered.pipeableStream);

        if (tracingEnabled) {
          dispatchPhase(buildTracingContext(request), {
            name: "stream.end",
            durationMs: performance.now() - streamEndStartedAt,
          });
        }

        return;
      }

      await response.html(rendered.html, status);
    } catch (thrown) {
      // Floor first, before any error page renders: this path runs outside the
      // pipeline, so `buildErrorRecord` never saw `thrown`. Without this line a
      // framework failure here (a module that fails to load, a cache driver
      // that was never initialised) reaches the visitor only through the app's
      // `error.page.tsx`, and the server log stays empty.
      reportServerError(`page request ${request.method} ${request.path} failed`, thrown, {
        kind: "request-handler",
        phase: "request-handler",
        routeName: name,
        routePath: path,
        pathname: pathnameFromRequest(request),
        method: request.method,
        requestId: request.id,
      });

      // This is outside the page pipeline: loading/registering a module can
      // fail before a triple exists for its authored boundaries to handle.
      // Reuse this request/response pair so headers, nonce and response
      // ownership remain exactly the same as the ordinary path.
      //
      // Nested try/catch, deliberately: this block's own job is to render a
      // NICER answer for `thrown` — it must never let a failure IN THAT
      // ATTEMPT (`renderPageFailure` itself throwing, or misbehaving) replace
      // `thrown` with a less useful error. If rendering the failure page
      // fails too, the original throw escapes exactly as it would have with
      // no try/catch at all (the file header's stated contract) — the
      // router's own error path is still the answer, just one throw later.
      try {
        await writePageFailureResponse({
          name,
          request,
          response,
          thrown,
          loadErrorPage,
          stylesheetUrls,
          hydrationClientModuleUrl,
          cache,
          wantsData,
          applyBufferedCookie,
        });
      } catch {
        throw thrown;
      }
    }
  };
}
