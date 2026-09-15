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
import { stringify } from "devalue";

import {
  DATA_RESPONSE_CONTENT_TYPE,
  isDataRequest,
  WARLOCK_DATA_REQUEST_HEADER,
} from "../routing/data-request";
import { isCrawlerRequest } from "./detect-crawler";
import { registerModules, type RegisterableModuleNamespace } from "../register-modules";
import { buildHydrationPayload } from "./build-hydration-payload";
import { applyResponseCacheFloor } from "./response-cache-floor";
import type { PageCacheOptIn } from "../routing/route-identity";
import { resolveAuthCookieName } from "./auth-cookie-name";
import { looksAuthenticated, isStoreEligible } from "./page-cache-eligibility";
import { computePageCacheKey, type PageCacheVariant } from "./page-cache-key";
import { getPageCacheEntry, setPageCacheEntry } from "./page-cache-store";
import { ensureSetCookieCacheFloorHook, markPageResponse } from "./set-cookie-cache-floor-hook";
import type { BufferedCookie, PageRouteEntry, PageTripleModule } from "./execute-page-request";
import { renderPageFailure, renderPageRequest, type RenderedPage } from "./render-page";
import { NDJSON_CONTENT_TYPE, writeDeferredNdjsonResponse } from "./write-deferred-ndjson-response";

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
 * Stage 10a — apply the stage 7 commit (headers, then cookies) to the LIVE
 * response, once, before either terminal write (10b: `html()` or `send()`).
 * Both the document and data representations of a page route go through this
 * so a client navigation never drops a `Set-Cookie` a full load would have
 * kept (`create-page-route-handler.spec.ts` — "applies committed cookies and
 * headers exactly as the document path does").
 */
function applyCommit(
  response: Response,
  rendered: Pick<RenderedPage, "headers" | "cookies">,
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void,
): void {
  response.headers(rendered.headers ?? {});

  for (const cookie of rendered.cookies ?? []) {
    applyBufferedCookie(response, cookie);
  }
}

/**
 * `changeLocaleCode()`'s client half asks for a locale switch by putting
 * `?locale=<code>` on a navigation DATA request's FETCH URL only — never on a
 * document load, and never any other way (`client/navigation/change-locale-code.ts`).
 * Persisting it here, through the SAME `response.setLocale()` an ordinary
 * controller would call, writes the SAME cookie `request.locale` already read
 * it back from (`core/src/http/request.ts:352-360`), so a later full load
 * agrees without the query param.
 *
 * `request.locale`, not the raw query value: `resolveLocale()` has already run
 * the query value through `cacheLocale()`'s `app.localeCodes` allow-list by
 * the time this runs, so a code outside it is already the configured
 * fallback — and the fallback, not what the client asked for, is what gets
 * persisted.
 *
 * Called from TWO seams that must never disagree: the MISS/full-render path
 * below (`if (wantsData)`), and the cache HIT path above it. A HIT never runs
 * the loader/render pipeline at all — that is the entire point of caching —
 * but it must still run this ONE side effect, or a locale switch served from
 * a warm cache entry returns the right body while silently never persisting
 * the cookie, and the next full load reverts to the old locale
 * (`page-server-cache.spec.ts` — "a HIT still persists a requested locale
 * switch"). A full document load with the same `?locale=` param never calls
 * this — it is gated on `wantsData` by both call sites — so it never
 * persists.
 */
function persistRequestedLocale(request: Request, response: Response): void {
  if (typeof request.query["locale"] === "string" && request.query["locale"].length > 0) {
    response.setLocale(request.locale);
  }
}

/**
 * Resolves a route's `cache.tags` (static list or a function of the
 * resolved page data) into a concrete list at store time. Called with
 * `rendered.data` — the page's own loader data (`RenderedPage.data`,
 * `render-page.ts`) — as the most sensible "data" argument for the function
 * form: it is the same value a page's own component/loader already sees, and
 * is available at this seam without threading anything new through.
 */
function resolveCacheTags(tags: PageCacheOptIn["tags"], data: unknown): string[] {
  if (tags === undefined) return [];

  return typeof tags === "function" ? tags(data) : tags;
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
  /**
   * Stylesheet URLs for this page, emitted into `<head>` so the FIRST paint is
   * styled. Absent or empty means the application has no CSS — it never means
   * a stylesheet failed to resolve, which is the build's job to report.
   */
  stylesheetUrls?: readonly string[];
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
    loadErrorPage,
    loadRegistrationLayouts,
    hydrationClientModuleUrl,
    stylesheetUrls,
    matchPath,
    statusForRenderedOk,
    skipPageLoader = false,
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

  return async ({ request, response }: HttpContext) => {
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
    const credentialedRequest =
      cache?.serverCache === true && request.method === "GET"
        ? looksAuthenticated(request, resolveAuthCookieName())
        : false;

    let cacheHeaderValue: "hit" | "miss" | "bypass" | undefined;
    let cacheKey: string | undefined;
    let attemptStorageAfterRender = false;

    try {
      if (cache?.serverCache === true) {
        if (request.method !== "GET") {
          // Decision 3 ("GET only"): a non-GET request to a serverCache route
          // is never looked up and never stored — it flows through the
          // ordinary pipeline below untouched, just reporting a miss-shaped
          // header since nothing was ever cached for it either way.
          cacheHeaderValue = "miss";
        } else if (credentialedRequest) {
          cacheHeaderValue = "bypass";
        } else {
          cacheKey = computePageCacheKey({
            path: request.path,
            query: request.query as Record<string, unknown>,
            locale: request.locale,
            variant: pageCacheVariant,
          });

          const hit = await getPageCacheEntry(cacheKey);

          if (hit !== undefined) {
            // A HIT is always served buffered, straight from the store, with
            // no loader and no render — see `render-page.ts`'s
            // await-and-inline path, reused only on the MISS side below.
            markPageResponse(request);

            // BEFORE the early return, and before the `Cache-Control` below:
            // a navigation data request's `?locale=` switch must persist even
            // when served from the cache — see `persistRequestedLocale`. When
            // it does write a cookie, the `Set-Cookie` cache-floor `onSend`
            // hook (`set-cookie-cache-floor-hook.ts`, registered above) then
            // downgrades the `Cache-Control` this seam is about to set to
            // `private, no-store` at send time — the same floor a MISS gets
            // from `applyResponseCacheFloor`, just applied one hook later.
            if (wantsData) {
              persistRequestedLocale(request, response);
            }

            // Replays exactly what a MISS on this same route would emit: the
            // opt-in already requires `public: true`, so this is the same
            // `Cache-Control` `applyResponseCacheFloor` would compute for a
            // store-eligible response (`authDerived === false`, no cookie —
            // both already proven true of whatever got stored).
            response.header("Cache-Control", `public, max-age=${cache.maxAge}`);
            response.header("x-warlock-cache", "hit");

            if (hit.usesDefer) {
              response.header("Vary", "User-Agent");
            }

            if (pageCacheVariant === "json") {
              response.header("Vary", WARLOCK_DATA_REQUEST_HEADER);
              response.setContentType(hit.contentType);
              await response.send(hit.body, hit.status);
            } else {
              await response.html(hit.body, hit.status);
            }

            return;
          }

          cacheHeaderValue = "miss";
          attemptStorageAfterRender = true;
        }
      }

      const [appModule, layoutModule, ownPageModule, registrationLayouts] = await Promise.all([
        loadModule(appFile),
        layoutFile ? loadModule(layoutFile) : Promise.resolve({}),
        loadModule(pageFile),
        loadRegistrationLayouts?.() ?? Promise.resolve([]),
      ]);

      // Registration is the first lifecycle action after all module namespaces
      // have loaded and before `renderPageRequest` can run middleware, loaders or
      // render. App/page are already their real namespaces. Layouts deliberately
      // come from the separate raw chain above, never from `layoutModule`, which
      // may be the synthetic composed middleware wrapper used by dev.
      registerModules([
        appModule as RegisterableModuleNamespace,
        ...registrationLayouts,
        ownPageModule as RegisterableModuleNamespace,
      ]);

      const pageModule = ownPageModule as PageTripleModule;
      const triple: PageRouteEntry["triple"] = {
        app: appModule as PageTripleModule,
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
        awaitDeferredForDataRequest: attemptStorageAfterRender ? wantsData : wantsData && !wantsNdjson,
        stylesheetUrls,
        hydrationClientModuleUrl,
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
      });

      if (rendered instanceof Response) return rendered;

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

      applyResponseCacheFloor(response, {
        authDerived: authDerivedState,
        cache,
      });

      // Emitted at the SAME seam as the floor, right after it, per lead
      // decision 8/design note §6 — so the two headers can never be computed
      // from different auth-state reads. Absent entirely for a route without
      // `serverCache`.
      if (cacheHeaderValue !== undefined) {
        response.header("x-warlock-cache", cacheHeaderValue);
      }

      // Store-time eligibility (lead decision 3), checked once we actually
      // have a rendered response to store. `precomputedJsonBody` lets the
      // `wantsData` branch below reuse the exact string just written to the
      // cache instead of calling `stringify(buildHydrationPayload(...))`
      // twice.
      let precomputedJsonBody: string | undefined;

      if (attemptStorageAfterRender && cacheKey !== undefined && cache !== undefined) {
        const eligible = isStoreEligible({
          method: request.method,
          authDerived: authDerivedState,
          response,
          status,
          crawler,
          hasBufferedCookie:
            (rendered.cookies?.length ?? 0) > 0 ||
            Boolean((rendered.headers as Record<string, unknown> | undefined)?.["set-cookie"]),
        });

        if (eligible) {
          const ttl = cache.ttl ?? cache.maxAge;
          const tags = resolveCacheTags(cache.tags, rendered.data);

          if (pageCacheVariant === "html") {
            await setPageCacheEntry(
              cacheKey,
              {
                body: rendered.html,
                status: 200,
                contentType: "text/html",
                usesDefer: rendered.usesDefer ?? false,
              },
              ttl,
              tags,
            );
          } else if (rendered.bundle !== undefined) {
            precomputedJsonBody = stringify(buildHydrationPayload(rendered.bundle, request.locale));

            await setPageCacheEntry(
              cacheKey,
              {
                body: precomputedJsonBody,
                status: 200,
                contentType: DATA_RESPONSE_CONTENT_TYPE,
                usesDefer: rendered.usesDefer ?? false,
              },
              ttl,
              tags,
            );
          }
        }
      }

      if (wantsData) {
        // See `persistRequestedLocale` — the cache HIT branch above calls the
        // same function, for the same reason.
        persistRequestedLocale(request, response);

        // So a shared cache can never serve a document to a client that asked for
        // JSON, or the reverse. See `data-request.ts` on why this stays even
        // while page responses are `no-store`.
        response.header("Vary", WARLOCK_DATA_REQUEST_HEADER);

        // `bundle` is absent on exactly one path: nothing matched, so no pipeline
        // ran and there is no payload to build. Fastify already matched this
        // route to get here, so reaching it means `request.path` did not satisfy
        // the entry's own pattern — answered as the 404 it is, rather than
        // synthesising an empty payload the client would try to render as a page.
        if (rendered.bundle === undefined) {
          response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
          await response.send(JSON.stringify({ error: "not_found" }), status);

          return;
        }

        // Stage 2 slice S3 (contract rule 10): a page that deferred at least
        // one key, asked for over `Accept: application/x-ndjson`, streams
        // instead of answering one buffered JSON body. A page with no
        // deferred keys is UNCHANGED under either `Accept` value — it never
        // reaches this branch, `deferredKeys` is undefined/empty for it.
        const deferredKeys = rendered.bundle.deferredKeys;

        if (wantsNdjson && deferredKeys !== undefined && deferredKeys.length > 0) {
          await writeDeferredNdjsonResponse(response, rendered.bundle, request.locale, status);

          return;
        }

        // SERIALIZED HERE, and handed over as a STRING on purpose.
        //
        // `response.send(object)` runs the body through core's `Response.parse`,
        // which recurses the object, calls `toJSON()` on anything that has one
        // (assigning `request` onto it as it goes) and rebuilds arrays. That is
        // the right behaviour for a controller returning Resources; it is the
        // wrong behaviour here, because the DOCUMENT path serializes this exact
        // object with devalue's `stringify` into `#__WARLOCK_DATA__`. Routing
        // one path through a transformer and not the other is precisely the
        // drift `build-hydration-payload.ts` exists to prevent — the browser
        // would build one tree on a page load and a different one on a
        // navigation to the same URL.
        //
        // A string body also bypasses `parseBody()` entirely, so the content type
        // has to be declared rather than inferred from an object body.
        //
        // CONTENT TYPE: kept as `DATA_RESPONSE_CONTENT_TYPE` (`application/json`)
        // deliberately. devalue's `stringify` output is syntactically valid JSON
        // text — it only recurses `["Date", ...]`/`["Map", ...]`-shaped arrays and
        // reference indices instead of the literal object graph, so `JSON.parse`
        // never throws on it, it just does not reconstruct the same value devalue
        // does. `application/json` here documents "the bytes are valid JSON",
        // which is true; the semantic decode is `readHydrationPayload`'s job, not
        // this response's content type.
        response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
        await response.send(
          precomputedJsonBody ?? stringify(buildHydrationPayload(rendered.bundle, request.locale)),
          status,
        );

        return;
      }

      // Rule 4: a page that never calls `defer()` renders identically for
      // every user agent, so its headers stay untouched. A page that DOES
      // defer renders differently for a detected crawler (the fully
      // resolved document) than for anything else (the streamed shell) —
      // the one axis this framework varies a document response on by
      // `User-Agent` — so a shared cache must be told.
      if (rendered.usesDefer) {
        response.header("Vary", "User-Agent");
      }

      // A page middleware that returned 2xx content without writing the reply
      // replaces the page: its value is the body, so there is no document to
      // decorate with stylesheets or the hydration module.
      const shortCircuit = rendered.bundle?.shortCircuit;

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
        const rendered = await renderPageFailure({
          name,
          path: request.path,
          request,
          response,
          thrown,
          loadErrorPage,
          stylesheetUrls,
          hydrationClientModuleUrl,
        });

        applyCommit(response, rendered, applyBufferedCookie);

        if (wantsData) {
          response.header("Vary", WARLOCK_DATA_REQUEST_HEADER);
          response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
          await response.send(stringify(buildHydrationPayload(rendered.bundle!, request.locale)), 500);
          return;
        }

        // `renderPageFailure` renders stylesheets and (when hydratable, which
        // this path never is) the hydration module through React already —
        // see that function. Nothing left to splice here either.
        await response.html(rendered.html, 500);
      } catch {
        throw thrown;
      }
    }
  };
}
