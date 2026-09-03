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
import { container, Response, type FastifyInstance, type HttpContext } from "@warlock.js/core";

import {
  DATA_RESPONSE_CONTENT_TYPE,
  isDataRequest,
  WARLOCK_DATA_REQUEST_HEADER,
} from "../routing/data-request";
import { registerModules, type RegisterableModuleNamespace } from "../runtime/register-modules";
import { buildHydrationPayload } from "./build-hydration-payload";
import { applyResponseCacheFloor } from "./response-cache-floor";
import type { PageCacheOptIn } from "../routing/route-identity";
import { ensureSetCookieCacheFloorHook, markPageResponse } from "./set-cookie-cache-floor-hook";
import type { BufferedCookie, PageRouteEntry, PageTripleModule } from "./execute-page-request";
import { isNonHydrating } from "./page-render-bundle";
import { renderPageFailure, renderPageRequest, type RenderedPage } from "./render-page";

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
 * is nothing here for a second implementation to drift from. The one-liner
 * `dev-server.ts` wires as the production default; passed in (`applyBufferedCookie`
 * option, below) rather than imported so this file stays free of anything
 * Vite-shaped.
 */
function defaultApplyBufferedCookie(response: Response, cookie: BufferedCookie): void {
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
  /** Same helper `dev-server.ts` exports — passed in, never imported. */
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

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function installHydrationClientModule(
  html: string,
  moduleUrl: string | undefined,
  nonce: string | undefined,
): string {
  if (moduleUrl === undefined || html === "") return html;

  const closingBodyIndex = html.lastIndexOf("</body>");
  if (closingBodyIndex === -1) {
    throw new Error(
      "installPageRoutes: cannot install the hydration client module because the rendered document has no closing </body> tag.",
    );
  }

  const nonceAttribute = nonce === undefined ? "" : ` nonce="${escapeHtmlAttribute(nonce)}"`;
  const script = `<script type="module"${nonceAttribute} src="${escapeHtmlAttribute(moduleUrl)}"></script>`;
  return `${html.slice(0, closingBodyIndex)}${script}${html.slice(closingBodyIndex)}`;
}

/**
 * Put the page's stylesheets in `<head>`, so the first paint is styled.
 *
 * Without this the document carries no CSS at all. The stylesheet reaches the
 * browser only because the CLIENT bundle imports it, which means it is applied
 * by JavaScript after the module graph loads — the page renders unstyled first
 * and restyles a moment later. Correct markup, wrong-looking page, and nothing
 * in the console to explain it.
 *
 * A `<link>` in `<head>` is render-blocking, which is exactly what is wanted
 * here: the browser holds the first paint until the CSS is in, so there is no
 * flash rather than a faster ugly one.
 *
 * Inserted before `</head>` rather than after `<head>` so an application's own
 * `<link>`/`<style>` in the root document still comes FIRST and can be
 * overridden by these — matching how the framework's tags are documented to
 * behave, and keeping cascade order predictable.
 */
function installStylesheets(html: string, stylesheetUrls: readonly string[]): string {
  if (stylesheetUrls.length === 0 || html === "") return html;

  const closingHeadIndex = html.lastIndexOf("</head>");

  // No `<head>` is not an error the way a missing `</body>` is: a root that
  // renders no head is unusual but legal, and losing the stylesheet is a
  // cosmetic failure where losing hydration is a broken page. Silently
  // dropping it would be the wrong trade the other way, though — so the
  // document is left exactly as rendered and the caller's own missing-`</body>`
  // check remains the loud one.
  if (closingHeadIndex === -1) return html;

  const links = stylesheetUrls
    .map((url) => `<link rel="stylesheet" href="${escapeHtmlAttribute(url)}">`)
    .join("");

  return `${html.slice(0, closingHeadIndex)}${links}${html.slice(closingHeadIndex)}`;
}

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

    try {
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
      const [requestPathname] = requestUrl.split("?");
      const routes: PageRouteEntry[] = [
        { path: matchPath === undefined ? path : matchPath(requestPathname), name, triple },
      ];

      // A DATA request runs everything above and below this line identically —
      // it is the same route, the same match and the same pipeline — and differs
      // only in what gets written at the end. Decided here, before the render, so
      // the branch is visibly about REPRESENTATION and not about behaviour.
      const rendered = await renderPageRequest(requestUrl, {
        routes,
        createHttp: () => ({ request, response }),
        loadErrorPage,
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
      applyResponseCacheFloor(response, {
        authDerived: request.locals === undefined ? undefined : request.locals.authDerived === true,
        cache,
      });

      if (wantsData) {
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

        // SERIALIZED HERE, and handed over as a STRING on purpose.
        //
        // `response.send(object)` runs the body through core's `Response.parse`,
        // which recurses the object, calls `toJSON()` on anything that has one
        // (assigning `request` onto it as it goes) and rebuilds arrays. That is
        // the right behaviour for a controller returning Resources; it is the
        // wrong behaviour here, because the DOCUMENT path serializes this exact
        // object with a plain `JSON.stringify` into `#__WARLOCK_DATA__`. Routing
        // one path through a transformer and not the other is precisely the
        // drift `build-hydration-payload.ts` exists to prevent — the browser
        // would build one tree on a page load and a different one on a
        // navigation to the same URL.
        //
        // A string body also bypasses `parseBody()` entirely, so the content type
        // has to be declared rather than inferred from an object body.
        response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
        await response.send(
          JSON.stringify(buildHydrationPayload(rendered.bundle, request.locale)),
          status,
        );

        return;
      }

      // Stylesheets first: they go in `<head>`, the hydration module goes before
      // `</body>`, and doing the head work on the already-rendered string keeps
      // both splices in one place rather than threading CSS through the React
      // render just to reach the same bytes.
      const styled = installStylesheets(rendered.html, stylesheetUrls ?? []);

      const html = installHydrationClientModule(
        styled,
        hydrationClientModuleUrl,
        hydrationClientModuleUrl === undefined ? undefined : request.nonce,
      );

      await response.html(html, status);
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
        });

        applyCommit(response, rendered, applyBufferedCookie);

        if (wantsData) {
          response.header("Vary", WARLOCK_DATA_REQUEST_HEADER);
          response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
          await response.send(
            JSON.stringify(buildHydrationPayload(rendered.bundle!, request.locale)),
            500,
          );
          return;
        }

        const styled = installStylesheets(rendered.html, stylesheetUrls ?? []);

        // `renderPageFailure` marks its bundle non-hydrating (page-render-bundle.ts):
        // there is no triple, so there is nothing on the client the hydration
        // module could attach to. Injecting it anyway would ship a script that
        // hydrates against a composition the server never trusted.
        const html = isNonHydrating(rendered.bundle)
          ? styled
          : installHydrationClientModule(
              styled,
              hydrationClientModuleUrl,
              hydrationClientModuleUrl === undefined ? undefined : request.nonce,
            );
        await response.html(html, 500);
      } catch {
        throw thrown;
      }
    }
  };
}
