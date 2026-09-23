import { createElement, StrictMode, type ComponentType, type ReactNode } from "react";
import type { PipeableStream, RenderToPipeableStreamOptions } from "react-dom/server";
import {
  buildTracingContext,
  dispatchPhase,
  environment,
  getPublicUrl,
  isTracingEnabled,
  Response,
  type Request,
} from "@warlock.js/core";
import DefaultApp from "../components/default-app";
import {
  DocumentContext,
  escapePayload,
  PAYLOAD_SCRIPT_ID,
  type DocumentContextValue,
  type SerializedErrorPageProps,
} from "../components/document-context";
import type { SharedContext } from "../index";
import { LocaleProvider } from "../localization";
import { buildHydrationPayload } from "./build-hydration-payload";
import {
  hydrationErrorPageProps,
  resolveErrorPageMetadata,
  type ErrorPageModule,
  type ErrorPageModuleLoader,
} from "./error-page";
import { ERROR_PAGE_METADATA } from "./resolve-page-metadata";
import { registerModules, type RegisterableModuleNamespace } from "../register-modules";
import { markNonHydrating } from "./page-render-bundle";
import { resolveDocumentLocaleRouting, resolveLocaleAlternates } from "./resolve-locale-alternates";
import { readLocaleRouting } from "../routing/locale-routing";
import type { ServerErrorPageProps } from "../props";
import {
  buildErrorRecord,
  designateBoundary,
  executePageRequest,
  type BufferedCookie,
  type ExecutePageRequestOptions,
  type PageDataBundle,
  type PageErrorRecord,
  type PageLevelName,
  type PageResponseCommit,
  type PageRouteEntry,
  type PageRouteMatch,
  type PageTripleModule,
} from "./execute-page-request";
import { PageMiddlewareShortCircuitError } from "./page-middleware-short-circuit-error";
import { ClientDisconnectedError } from "./client-disconnected-error";
import { wrapPipeableStreamForDeferredEmission } from "./defer-emission";
import { reportServerError } from "./report-server-error";
import { pathnameFromRequest } from "./error-reporting-config";
import { requestStylesheetSources } from "../request-stylesheets";
import {
  documentStylesheetUrls,
  type RequestStylesheetUrlResolver,
} from "./document-stylesheet-urls";
import type { DeferSettlement } from "./defer-settlement";
import { createSettledThenable } from "../loaders/settled-thenable";
import { bindRequestRouteTranslations } from "./request-route-translations";
import { resolveNamedApiRoutes } from "./named-api-routes";

export { escapePayload, PAYLOAD_SCRIPT_ID };
export type { BufferedCookie };

/** Widens `PageDataBundle` with the stage 7 commit record — see `execute-page-request.ts`. */
type Bundle = PageDataBundle & { commit?: PageResponseCommit };

/** Reads the stage 7 commit into the lowercased header map `RenderedPage` carries. */
function committedHeaders(bundle: PageDataBundle): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const header of (bundle as Bundle).commit?.headers ?? []) {
    headers[header.key.toLowerCase()] = header.value;
  }

  return headers;
}

/** Reads the stage 7 commit into the cookie list `RenderedPage` carries. */
function committedCookies(bundle: PageDataBundle): BufferedCookie[] {
  return (bundle as Bundle).commit?.cookies ?? [];
}

/**
 * Pipeline stages 9–10: RENDER the page tree from the
 * data bundle stages 1–8 produced, then return finalized { html, status,
 * headers }. Stage 10 happens at the CALL SITE in two halves —
 * 10a the caller applies status + headers (the single live-response write,
 * after render, before anything flushes), 10b it flushes
 * the document. Nothing in this module writes the live response. It never
 * re-runs any earlier stage — `renderPageRequest` calls `executePageRequest`
 * and everything here consumes its bundle as-is.
 *
 * `renderPageRequest` is deliberately double-duty: it is the production
 * orchestrator AND the test helper. Because a loader IS
 * a controller, `renderPageRequest("/products/42")` returns
 * `{ html, status, headers, data }` in one call — asserting a page's data and
 * its response headers is a unit test, no browser, no server boot.
 */

// ---------------------------------------------------------------------------
// renderPageRequest surface
// ---------------------------------------------------------------------------

type RouteRegistry = {
  routes: readonly PageRouteEntry[];
  createHttp: ExecutePageRequestOptions["createHttp"];
};

export type RenderPageRequestOptions = {
  routes: readonly PageRouteEntry[];
  /** Core's already-resolved HTTP route, when this is serving a live request. */
  matched?: Pick<PageRouteMatch, "entry" | "params">;
  createHttp: ExecutePageRequestOptions["createHttp"];
  /** Loaded only after the ordinary boundary chain has been exhausted. */
  loadErrorPage?: ErrorPageModuleLoader;
  routeTranslations?: import("./route-translations").RouteTranslations;
  getRouteTranslations?: import("./route-translations").RouteTranslationsResolver;
  errorPageFile?: string;
  appFile?: string;
  pageFile?: string;
  /**
   * True for the JSON representation of a page route (`create-page-route-handler.ts`'s
   * `wantsData` branch) — a client navigation, never a browser address-bar
   * load. `finishRender` reads this to decide what a failed page `validation`
   * produces: a full-document request renders the application's
   * `error.page.tsx`/boundary chain with status 400 (the fix this option
   * exists for); a data request keeps its untouched, pre-existing contract —
   * `{ html: "", status: 400 }` with `bundle.shortCircuit` carrying the
   * errors, exactly as before. Defaults to `false` (a document request) so
   * every caller that never mentions representation — every test in this
   * file included — keeps rendering the full document it always has.
   */
  dataRequest?: boolean;
  /**
   * This page's resolved stylesheet URLs, in cascade order — carried onto
   * `DocumentContextValue.stylesheetUrls` so `<Head/>` renders them as real
   * `<link>` tags (Stage 1 streaming SSR moved this off the old post-render
   * splice; see `document-context.ts`).
   */
  stylesheetUrls?: readonly string[];
  /** The hydration client entry module URL — carried onto `DocumentContextValue.hydrationClientModuleUrl`, same reasoning. */
  hydrationClientModuleUrl?: string;
  /** `modulepreload` URLs for the entry's own static imports — carried onto `DocumentContextValue.hydrationClientModulePreloadUrls`, same reasoning (card 53f8647e). */
  hydrationClientModulePreloadUrls?: readonly string[];
  /**
   * Turns the source ids THIS request declared through `linkStylesheetsFor()`
   * into stylesheet URLs (manifest in production, module graph in dev). Called
   * at stage 9, after middleware and loaders ran, only when something was
   * declared; its URLs are appended after {@link stylesheetUrls}.
   */
  resolveRequestStylesheetUrls?: RequestStylesheetUrlResolver;
  /**
   * Selects `onAllReady` (true) over `onShellReady` (false, the default) as
   * the point at which `pipeableStream` on {@link RenderedPage} becomes
   * ready to pipe. Stage 1 renders no Suspense boundaries (`defer()` is
   * Stage 2), so the two currently settle at the same moment for every page
   * this framework can render today; the flag exists so a future crawler
   * path (explicitly out of scope for this card) has somewhere to plug in
   * without another signature change.
   */
  waitForAll?: boolean;
  /**
   * True when a DATA request should AWAIT every deferred settlement and
   * inline the resolved values into `pageData` instead of leaving
   * `deferredKeys`/`deferredSettlements` on the bundle for the caller to
   * stream as NDJSON. Ignored when `dataRequest` is false or the page has no
   * deferred keys. Defaults to `false` so the NDJSON representation (and
   * every existing caller of this option-less surface) keeps the bundle
   * untouched for itself to consume — see `finishRender`'s own doc comment
   * at the point this is read.
   */
  awaitDeferredForDataRequest?: boolean;
  /**
   * Crawler mode: a FULL-DOCUMENT request from a detected crawler
   * (`detect-crawler.ts`) must
   * receive every `defer()`-ed value already resolved and inlined in the
   * HTML before the first byte — a non-JS crawler has no chance to observe
   * a later chunk the way a browser does, so indexing needs nothing else.
   * When true on a document request (`dataRequest` false) with deferred
   * keys, `finishRender` reuses the SAME await-and-inline path
   * `awaitDeferredForDataRequest` drives for a data request — every
   * deferred value settles and is inlined into `pageData` before render, a
   * rejection escalates through the ordinary boundary chain with its real
   * status, and the render additionally waits for `onAllReady` (see
   * `waitForAll`, forced on below) before the first byte, since nothing has
   * flushed yet. The document still keeps `deferredKeys`/`deferredSettlements`
   * on the bundle so the ordinary `__WARLOCK_DEFER__` settlement chunks
   * still emit — a JS-capable crawler hydrates `use(data.key)` through the
   * existing registry exactly like a browser. Ignored for a data request —
   * that representation is governed by `awaitDeferredForDataRequest` alone.
   * Defaults to `false`, so every existing document caller streams exactly
   * as before.
   */
  crawler?: boolean;
  /**
   * Forces `robots: "noindex"` onto the rendered document's metadata, whatever
   * the page declared. Set only for the not-found route
   * (`not-found-handler-options.ts`): a 404 document describes a URL with no
   * page behind it, and the framework fallback it stands in for
   * (`frameworkDefaultNotFoundDocument`) already says noindex. Defaults to
   * `false`, so every other page keeps exactly the metadata it resolved.
   */
  noindex?: boolean;
};

export type RenderedPage = {
  /**
   * The full document ("" when the pipeline short-circuited before render).
   * Built by the SAME final element `pipeableStream` (below) streams —
   * `finishRender` proves that element renders cleanly here, synchronously,
   * BEFORE ever starting the stream, so this string doubles as `renderPageRequest`'s
   * long-standing test-helper contract (assert on `.html` with no server, no
   * browser) and the input the escalation loop verifies is safe to stream.
   */
  html: string;
  status: number;
  /** Committed response headers, lowercased key → value. */
  headers: Record<string, string>;
  /** Committed response cookies, in commit order — stage 7's `bundle.commit.cookies`. */
  cookies: BufferedCookie[];
  /**
   * The PAGE loader's data — `data.product.name` reads as the dx story
   * writes it. `unknown`: the pipeline never checks a loader's return shape.
   */
  data: unknown;
  /**
   * The full stages-1–8 bundle, for assertions beyond the page's own data.
   * Undefined ONLY on `renderPageRequest`'s no-match path: no route matched,
   * so no pipeline ran and there is no bundle — the 404 answer stands alone.
   */
  bundle: PageDataBundle | undefined;
  /**
   * The React server stream for the SAME document `html` describes, ready to
   * pipe (its shell, or its whole tree when `waitForAll` was set) —
   * `create-page-route-handler.ts` pipes this through core's
   * `Response.streamReact` instead of sending `html` as a buffered body.
   *
   * Undefined for every RESPONSE that is not a rendered document: a
   * middleware 2xx short-circuit's own returned value, the empty-body
   * short-circuit/404 cases, and `renderPageFailure`'s pre-triple fallback
   * (which has no triple to prove safe to stream — see that function).
   */
  pipeableStream?: PipeableStream;
  /**
   * True when this page called `defer()` at all — set once, before crawler
   * mode may have already awaited and inlined every deferred value into
   * `pageData` (`bundle.deferredKeys` stays put on a crawler document so its
   * ordinary `__WARLOCK_DEFER__` settlement chunks still emit).
   * `create-page-route-handler.ts` reads this
   * to decide the `Vary: User-Agent` header (rule 4): a page with no
   * `defer()` renders identically for every user agent and must never carry
   * it, while a page that defers renders differently for a detected crawler
   * — the ONLY thing that varies by `User-Agent` this framework produces.
   * Undefined (falsy) on every short-circuit/failure return that never
   * reached the point this is decided.
   */
  usesDefer?: boolean;
};

export type RenderPageFailureOptions = {
  name: string;
  path: string;
  request: Request;
  response: Response;
  thrown: unknown;
  loadErrorPage?: ErrorPageModuleLoader;
  routeTranslations?: import("./route-translations").RouteTranslations;
  getRouteTranslations?: import("./route-translations").RouteTranslationsResolver;
  appFile?: string;
  errorPageFile?: string;
  /** Same as `RenderPageRequestOptions.stylesheetUrls` — stylesheets still render here, unconditionally. */
  stylesheetUrls?: readonly string[];
  /**
   * Same as `RenderPageRequestOptions.hydrationClientModuleUrl`. Threaded
   * through for type symmetry, but never actually reaches the document:
   * `Scripts` gates the client module on the same non-hydrating check as the
   * payload script, and this function's bundle is ALWAYS marked
   * non-hydrating (see the function doc below).
   */
  hydrationClientModuleUrl?: string;
};

function requireRegistry(options: RenderPageRequestOptions): RouteRegistry {
  const { routes, createHttp } = options;

  if (!routes || !createHttp) {
    throw new Error(
      "renderPageRequest() has no route registry (web/src/server/render-page.ts). " +
        "It resolves against the page manifest, which the server bootstrap owns. " +
        "Fix: pass { routes, createHttp } to this call.",
    );
  }

  return { routes, createHttp };
}

// ---------------------------------------------------------------------------
// Stage 9 — RENDER
// ---------------------------------------------------------------------------

/**
 * The framework-owned terminal boundary: designation falls back to
 * `app` even when no level exports one, because the framework owns a root
 * boundary. Deliberately generic: the error itself is server knowledge and
 * never serialized into the document.
 */
function FrameworkRootBoundary(): ReactNode {
  return createElement("main", { role: "alert" }, "Something went wrong.");
}

function errorPageElement(module: ErrorPageModule, props: ServerErrorPageProps): ReactNode {
  const ErrorPage = module.default as ((input: ServerErrorPageProps) => ReactNode) | undefined;
  if (!ErrorPage) {
    throw new Error("The application error.page.tsx module has no default export.");
  }
  return createElement(ErrorPage, props);
}

/**
 * THE single point that decides what `error.page.tsx` sees, in EITHER
 * representation of the same failure: SSR props (this return value) and the
 * hydration payload (`errorPage`, already built by `hydrationErrorPageProps`
 * before this is called). In production the two must be the SAME sanitized
 * {@link SerializedPageError} — never the raw `thrown` — or the initial HTML
 * leaks what the hydration payload just redacted and the two disagree at
 * hydration (card c52d5653). Development is unchanged: the raw error, same
 * as before this rule existed.
 */
export function resolveServerErrorPageProps(
  props: ServerErrorPageProps,
  errorPage: SerializedErrorPageProps,
): ServerErrorPageProps {
  if (environment() !== "production") return props;
  return { ...props, error: errorPage.error };
}

type LevelProps = {
  data: unknown;
  shared: Readonly<SharedContext> | undefined;
  children?: ReactNode;
};

/** The ordinary page leaf alone receives the route match's params. */
type PageLevelProps = {
  data: unknown;
  shared: Readonly<SharedContext> | undefined;
  params: Readonly<Record<string, string>>;
};

const DATA_KEYS: Record<PageLevelName, "appData" | "layoutData" | "pageData"> = {
  app: "appData",
  layout: "layoutData",
  page: "pageData",
};

/**
 * Compose the tree root→leaf: `<App><Layout><Page/></Layout></App>`, each
 * level receiving ITS OWN loader data and the same sealed `shared` — the
 * exact props the M1 contract declares (web/src/props.ts) and never
 * request/response (the component also renders on a machine where neither
 * exists, props.ts:19-22).
 *
 * A level with no default export contributes no DOM and passes children
 * through — that is `layout.tsx` omitting its default export to be a guard
 * with no DOM.
 */
function buildPageElement(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
): ReactNode {
  return wrapRootward(triple, bundle, "page", buildLeaf(triple.page, bundle));
}

/**
 * The error path renders the DESIGNATED boundary in place of the level it
 * covers, still wrapped by every level rootward of it — a page-level throw
 * keeps its App and Layout chrome, whose data survived the settle rules:
 * fulfilled sibling data stays in the bundle.
 *
 * `record` is explicit rather than read from `bundle.error` — a render-time
 * throw (`finishRender`'s stage 9 escalation loop) designates a NEW boundary on the fly that the stage 1-8 bundle never saw.
 */
function buildBoundaryElement(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
  record: PageErrorRecord,
): ReactNode {
  const { boundary, error } = record;
  const Boundary = triple[boundary.boundaryLevel].ErrorBoundary as
    ((props: { error: unknown }) => ReactNode) | undefined;

  const element = Boundary
    ? createElement(Boundary, { error })
    : createElement(FrameworkRootBoundary, {});

  const wrapped = wrapRootward(triple, bundle, boundary.boundaryLevel, element);

  // "App" has no level rootward of it, so `wrapRootward` returns `wrapped`
  // unwrapped when the boundary covers the app level itself — but the
  // pipeline always emits a complete document, so the
  // framework default supplies the shell here even though the app's own
  // (broken) root is what's being bypassed.
  return boundary.boundaryLevel === "app"
    ? createElement(DefaultApp, { children: strictPageTree(triple.app, wrapped) })
    : wrapped;
}

function strictPageTree(root: PageTripleModule, element: ReactNode): ReactNode {
  return root.strictMode === true ? createElement(StrictMode, null, element) : element;
}

function buildLeaf(module: PageTripleModule, bundle: PageDataBundle): ReactNode {
  const Component = module.default as ((props: PageLevelProps) => ReactNode) | undefined;

  if (!Component) return null;

  return createElement(Component as ComponentType<PageLevelProps>, {
    data: bundle.pageData,
    shared: bundle.shared,
    params: bundle.route.params,
  });
}

function wrapRootward(
  triple: Record<PageLevelName, PageTripleModule>,
  bundle: PageDataBundle,
  from: PageLevelName,
  leaf: ReactNode,
): ReactNode {
  const wrappers: PageLevelName[] =
    from === "page" ? ["layout", "app"] : from === "layout" ? ["app"] : [];

  let element = leaf;

  for (const level of wrappers) {
    // The document owns #vessel; only its page/layout children are hydrated.
    if (level === "app") element = strictPageTree(triple.app, element);

    const Component = triple[level].default as ((props: LevelProps) => ReactNode) | undefined;

    if (!Component) {
      // "App" is the root: no App export means no custom document, but the
      // pipeline always emits a complete one — the
      // framework default App supplies it. Layout has no such fallback: an
      // omitted layout default export stays a no-DOM passthrough,
      // unchanged from before.
      if (level === "app") {
        element = createElement(DefaultApp, { children: element });
      }

      continue;
    }

    element = createElement(Component as ComponentType<LevelProps>, {
      data: bundle[DATA_KEYS[level]],
      shared: bundle.shared,
      children: element,
    });
  }

  return element;
}

// ---------------------------------------------------------------------------
// Document assembly — stage 10 (10a apply + 10b flush) lives at the call site
// ---------------------------------------------------------------------------

/**
 * The root (App or the framework default) now ALWAYS renders a complete
 * `<html>…</html>` document itself — `<Head/>`/
 * `<Scripts/>` read the metadata/payload from `DocumentContext` (provided
 * around the element in `finishRender`, below) and emit real elements.
 * There is nothing left for this stage to assemble by string surgery; it
 * only prepends the doctype `renderToString` never includes.
 */
function emitDocument(body: string): string {
  return "<!DOCTYPE html>" + body;
}

// ---------------------------------------------------------------------------
// The shared tail (stages 9–10) — both orchestrators end here
// ---------------------------------------------------------------------------

/**
 * The real request/response pair `capturingCreateHttp` captured for this
 * call. It is used at the two orchestrator call sites to read the document
 * slots (`documentSlotsFrom`, below).
 */
type CapturedHttp = {
  request: Request;
  response: Response;
};

/**
 * Wrap the caller's createHttp to capture the real pair (for the document
 * slots, `documentSlotsFrom` below) and the matched entry (the only place a
 * URL-based caller learns which triple to render).
 */
function capturingCreateHttp(registry: RouteRegistry): {
  state: { captured?: CapturedHttp; match?: PageRouteMatch };
  createHttp: ExecutePageRequestOptions["createHttp"];
} {
  const state: { captured?: CapturedHttp; match?: PageRouteMatch } = {};

  return {
    state,
    createHttp(match) {
      state.match = match;
      state.captured = registry.createHttp(match);

      return state.captured;
    },
  };
}

/**
 * The two request-derived document slots (`nonce`/`lang` on
 * `DocumentContextValue`), extracted at the orchestrator call sites
 * because `finishRender` no longer carries `captured` (D1). `dir` is not
 * here: core's Request has no dir-like field (checked
 * core/src/http/request.ts — only `nonce` at :177 and `locale` at :343
 * exist) — an app supplies `dir` via its own convention.
 */
type DocumentSlots = {
  nonce?: string;
  locale: string;
};

/** Reads document slots directly from core's Request. */
function documentSlotsFrom(captured: CapturedHttp | undefined): DocumentSlots {
  if (captured === undefined) {
    throw new Error("The page pipeline reached rendering without its request context.");
  }

  return { nonce: captured.request.nonce, locale: captured.request.locale };
}

/**
 * Unconditional stderr floor for a render-time failure.
 *
 * An SSR component or boundary that throws during stage 9 is otherwise
 * SWALLOWED: the escalation loop below renders the deliberately-generic
 * `FrameworkRootBoundary` (or an authored boundary) in its place, the error is
 * never serialized into the document (server knowledge, `FrameworkRootBoundary`
 * above), and nothing in stages 1-9 logs it. In development that left a blank
 * 500 with no message in the response, no dev overlay, and no line in the dev
 * server's own log — the developer had nothing to debug with.
 *
 * This writes the error, with its stack, to stderr. It runs on BOTH dev and
 * production on purpose: a fatal reported only through a
 * configurable sink can vanish, so every fatal needs a floor that cannot be
 * silenced. stderr never reaches the client, so this leaks nothing that the
 * generic boundary was protecting; it only gives the terminal the one line
 * that locates the throw.
 */
function reportRenderError(
  route: PageDataBundle["route"],
  thrown: unknown,
  request: Request,
): void {
  const where = route?.path ?? route?.name ?? "an unknown route";
  reportServerError(`SSR render error while rendering ${where}`, thrown, {
    kind: "render",
    phase: "render",
    routeName: route?.name,
    routePath: route?.path,
    pathname: pathnameFromRequest(request),
    method: request.method,
    requestId: request.id,
  });
}

/**
 * Unconditional stderr floor for the application's OWN `error.page.tsx`
 * failing while rendering the fallback for some other error.
 *
 * The catch blocks around `renderErrorPage()` fall back to
 * `renderFrameworkAfterErrorPageFailure()` so the response is still a
 * complete document, but that fallback used to swallow the error page's own
 * throw entirely — a developer whose error.page.tsx itself threw got no
 * line anywhere, on top of the original failure it was meant to report. This
 * never replaces `reportRenderError`: the original error and the error
 * page's own failure are reported separately, since both matter.
 */
function reportErrorPageFailure(
  route: PageDataBundle["route"],
  thrown: unknown,
  request: Request,
): void {
  const where = route?.path ?? route?.name ?? "an unknown route";
  reportServerError(`the application error page itself failed while rendering ${where}`, thrown, {
    kind: "error-page",
    phase: "error-page",
    routeName: route?.name,
    routePath: route?.path,
    pathname: pathnameFromRequest(request),
    method: request.method,
    requestId: request.id,
  });
}

/**
 * Render an already-finalized document element through React's streaming
 * renderer, resolving once it is ready to pipe.
 *
 * `element` is the SAME wrapped element the escalation loop below just
 * proved renders cleanly via `renderToString` — this call exists to produce
 * the actual `PipeableStream` bytes go out on, not to re-decide what
 * renders. `onShellError` firing here would mean React's two renderers
 * disagree on the exact same tree, which the loop above has already ruled
 * out; it is still wired, defensively, straight into a rejection so a
 * caller that awaits this and lets it throw falls onto today's existing
 * error-page/escalation path with nothing yet written to the client — the
 * Stage 1 contract for "errors before the shell is ready".
 *
 * `allReady` (the returned `Promise<void>`) resolves whenever React's own
 * `onAllReady` fires, REGARDLESS of `waitForAll` — Stage 1 requests
 * (`waitForAll: false`) still start piping at `onShellReady`, but Stage 2's
 * `defer()` (contract rule 9: "end the response only after every deferred
 * key has settled AND `onAllReady` has fired") needs that later signal too,
 * so it is always requested from React, never gated on the same flag that
 * decides when piping may START.
 */
async function renderElementToPipeableStream(
  element: ReactNode,
  waitForAll: boolean,
  route: PageDataBundle["route"],
  /**
   * The SAME per-request CSP nonce `documentSlots.nonce` carries onto
   * `<Scripts/>`/`defer-emission.ts`'s own inline scripts — passed straight
   * through to React's `renderToPipeableStream`, which stamps it onto EVERY
   * inline `<script>` it emits itself: the bootstrap script and, for a
   * Suspense boundary that resolves after the shell, the `$RC`/`$RS`
   * boundary-reveal/segment scripts (card 3926afb3). Undefined when the app
   * has no CSP nonce configured for this request — React then emits its
   * inline scripts with no `nonce` attribute at all, exactly as before this
   * fix, so a deployment with CSP disabled sees no change.
   */
  nonce: string | undefined,
  /** Reporting context only (card 1db238ca) — never read for anything else here. */
  request: Request,
): Promise<{ pipeableStream: PipeableStream; allReady: Promise<void> }> {
  const { renderToPipeableStream } = await import("react-dom/server");

  let resolveAllReady!: () => void;
  const allReady = new Promise<void>((resolve) => {
    resolveAllReady = resolve;
  });

  const pipeableStream = await new Promise<PipeableStream>((resolve, reject) => {
    let stream: PipeableStream;
    const options: RenderToPipeableStreamOptions = {
      nonce,
      onShellError: (error) => reject(error),
      onError: (error) => {
        // A client disconnect aborts this SAME stream with
        // `ClientDisconnectedError` as its reason (below, and
        // `defer-emission.ts`'s `onClientDisconnect`) — expected, not a
        // render failure, so it never reaches `reportServerError`/the app's
        // `web.errors.report()` hook (card 0d43c0d6). One quiet debug line
        // is enough to see it happened at all.
        if (error instanceof ClientDisconnectedError) {
          console.debug(
            `[warlock:web] client disconnected while rendering ${route?.path ?? route?.name ?? "an unknown route"}`,
          );
          return;
        }

        // Stage 1 renders no Suspense boundaries of its own, so this firing
        // after the shell is ready is unexpected rather than a normal
        // deferred-content rejection (Stage 2's `defer()` settlements are
        // reported through their own floor — `defer-settlement.ts`'s
        // `reportServerError` — never through here) — report it through the
        // same floor a render-time throw already uses, rather than let it
        // vanish.
        reportRenderError(route, error, request);
      },
    };

    if (waitForAll) {
      // Nothing is written before `onAllReady`, so every boundary is complete
      // when the document flushes — but React Fizz still OUTLINES a completed
      // boundary (fallback + `<!--$?-->`, content in `<div hidden id="S:n">`,
      // swapped by `$RC`) once the bytes flushed so far plus its own exceed
      // `progressiveChunkSize` (12 800 by default). On a long page that turns
      // the last deferred sections into client-side swaps a non-JS crawler
      // never runs (canon cf11ec62, card e4db45bb). An unbounded budget keeps
      // every completed boundary inline.
      options.progressiveChunkSize = Number.POSITIVE_INFINITY;
      options.onAllReady = () => {
        resolveAllReady();
        resolve(stream);
      };
    } else {
      options.onShellReady = () => resolve(stream);
      options.onAllReady = () => resolveAllReady();
    }

    stream = renderToPipeableStream(element, options);
  });

  return { pipeableStream, allReady };
}

async function finishRender(
  triple: PageRouteEntry["triple"],
  bundle: PageDataBundle,
  documentSlots: DocumentSlots,
  response: Response,
  /**
   * The same request `documentSlotsFrom`'s `captured` pair carries — needed
   * here only to build the "render.shell" tracing context;
   * `finishRender` otherwise never reads it.
   */
  request: Request,
  loadErrorPage: ErrorPageModuleLoader | undefined,
  dataRequest: boolean,
  streamOptions: {
    stylesheetUrls: readonly string[] | undefined;
    hydrationClientModuleUrl: string | undefined;
    hydrationClientModulePreloadUrls?: readonly string[];
    resolveRequestStylesheetUrls?: RequestStylesheetUrlResolver;
    waitForAll: boolean;
    awaitDeferredForDataRequest?: boolean;
    /** See `RenderPageRequestOptions.crawler`. */
    crawler?: boolean;
    /** See `RenderPageRequestOptions.noindex`. */
    noindex?: boolean;
    getRouteTranslations?: import("./route-translations").RouteTranslationsResolver;
    appFile: string;
    errorPageFile?: string;
  },
): Promise<RenderedPage> {
  // Read from the stage 7 commit, never live off `response` — this function
  // writes (and now reads) the live response zero times. A bundle with no
  // commit (no loader ran at all) simply has no headers/cookies to report.
  const headers = committedHeaders(bundle);
  const cookies = committedCookies(bundle);

  // Captured before anything below may await-and-inline the deferred values
  // (crawler mode leaves `bundle.deferredKeys` itself in place; the data-request
  // wire clears it) — see `RenderedPage.usesDefer`.
  const usesDefer = (bundle.deferredKeys?.length ?? 0) > 0;

  // Set only by a successful `awaitAndInlineDeferred` pass for a DATA
  // request (never a crawler's document — see that block). Its `data` prop
  // (`bundle.pageData`) still needs the settled-thenable shape while the
  // page tree actually renders below, so `use()` in a `<Suspense>` reads it
  // synchronously the same way a crawler's document does; but a data
  // response has no hydration to feed the way a document's embedded
  // `#__WARLOCK_DATA__` does, so its OWN wire keeps inlining the plain
  // resolved value exactly as before this fix
  // (`__tests__/server/defer-data-request.spec.ts`). Deferred to run AFTER
  // the render below has read the thenable, not inline in that block, which
  // runs before the page tree is ever built.
  let restoreInlineDeferredForDataWire: (() => void) | undefined;

  // A page middleware short-circuit that (a) is a FULL-DOCUMENT request and
  // (b) never wrote the real HTTP reply itself gets handled below instead of
  // the empty-body branch — see the two cases right after this block. Every
  // OTHER middleware short-circuit keeps the untouched, pre-existing empty
  // body: a DATA request's `{ html: "", status, bundle.shortCircuit }`
  // contract must stay byte-identical, and a short-circuit whose
  // `responseSent` is true (a redirect, or a middleware that already called
  // `response.send()`/`.forbidden()` itself) has already put the real answer
  // on the wire — re-rendering here would only be discarded by
  // `Response.send()`'s own already-sent guard, or duplicate a reply the
  // client already received.
  const unsentMiddlewareShortCircuit =
    bundle.shortCircuit?.stage === "middleware" && !dataRequest && !bundle.shortCircuit.responseSent
      ? bundle.shortCircuit
      : undefined;

  // A failed page `validation`, on a FULL-DOCUMENT request, renders the
  // ordinary boundary/`error.page.tsx` pipeline below instead of returning
  // here — `bundle.error` was built alongside this same `shortCircuit`
  // (`execute-page-request.ts`) for exactly that. Validation on a DATA
  // request still emits no document: the data representation's
  // `{ html: "", status, bundle.shortCircuit }` contract must not change.
  if (
    bundle.shortCircuit &&
    !(bundle.shortCircuit.stage === "validation" && !dataRequest) &&
    unsentMiddlewareShortCircuit === undefined
  ) {
    const status =
      bundle.shortCircuit.stage === "validation"
        ? bundle.shortCircuit.status
        : (bundle.shortCircuit.statusCode ?? 200);
    return {
      html: "",
      status,
      headers,
      cookies,
      data: bundle.pageData,
      bundle,
    };
  }

  // The confirmed-broken case: a page middleware short-circuited a
  // full-document request without writing the real HTTP reply itself (e.g.
  // `return { message }`, or `response.setStatusCode(403)` followed by a
  // plain object) — the pipeline used to drop the returned value entirely
  // and answer an empty 200 document. Decided behaviour: a
  // >= 400 status renders the ordinary boundary/`error.page.tsx` pipeline,
  // exactly as a failed page validation already does; a 2xx status sends
  // the middleware's own returned value as the body, unchanged — a page
  // middleware returning 2xx content REPLACES the page.
  if (unsentMiddlewareShortCircuit !== undefined) {
    const statusCode = unsentMiddlewareShortCircuit.statusCode ?? 200;

    if (statusCode < 400) {
      const value = unsentMiddlewareShortCircuit.value;
      const body = typeof value === "string" ? value : JSON.stringify(value);

      return { html: body, status: statusCode, headers, cookies, data: bundle.pageData, bundle };
    }

    const boundary = designateBoundary(unsentMiddlewareShortCircuit.level, triple);
    bundle.error = buildErrorRecord(
      new PageMiddlewareShortCircuitError(statusCode, unsentMiddlewareShortCircuit.value),
      boundary,
      bundle.route.path,
      statusCode,
      {
        routeName: bundle.route.name,
        routePath: bundle.route.path,
        method: request.method,
        requestId: request.id,
      },
    );
  }

  // Stage 2 slice S3 (contract rule 10, the "without `Accept:
  // application/x-ndjson`" branch) AND crawler mode (Stage 1 point 6): a DATA
  // request that asked to await deferred values, OR a FULL-DOCUMENT request
  // from a detected crawler, does so HERE, before anything below decides how
  // to render — so a rejection is folded into `bundle.error` and falls
  // straight into the SAME escalation loop an ordinary synchronous loader
  // throw already goes through (boundary designation, `loadErrorPage`,
  // status), rather than a second, parallel error shape only this path
  // knows about. Every OTHER document request — the ordinary streaming
  // path — skips this entirely and leaves `deferredKeys`/`deferredSettlements`
  // on the bundle for its own post-shell chunk emission
  // (`defer-emission.ts`); so does the NDJSON data representation
  // (`awaitDeferredForDataRequest` false), which streams the same way itself
  // (`write-deferred-ndjson-response.ts`).
  const awaitAndInlineDeferred =
    (dataRequest && streamOptions.awaitDeferredForDataRequest === true) ||
    (!dataRequest && streamOptions.crawler === true);

  if (
    awaitAndInlineDeferred &&
    bundle.deferredKeys !== undefined &&
    bundle.deferredKeys.length > 0
  ) {
    const deferredKeys = bundle.deferredKeys;
    const settlements = bundle.deferredSettlements ?? {};
    const settled = await Promise.all(
      deferredKeys.map(
        (key) =>
          settlements[key] ?? Promise.resolve<DeferSettlement>({ ok: true, value: undefined }),
      ),
    );

    const rejectedIndex = settled.findIndex((entry) => !entry.ok);

    if (rejectedIndex === -1) {
      const pageDataRecord = (bundle.pageData ?? {}) as Record<string, unknown>;

      // A settled-but-not-yet-tracked value would still make `use()` suspend
      // once before reading it — `createSettledThenable` is what lets the
      // page tree below read it synchronously, with no fallback ever
      // rendered, in EITHER trigger of this branch (a crawler's document or
      // a data request's own escalation-loop render, which runs regardless
      // of `dataRequest` to prove the tree safe before streaming/returning
      // it).
      deferredKeys.forEach((key, index) => {
        pageDataRecord[key] = createSettledThenable(
          (settled[index] as { ok: true; value: unknown }).value,
        );
      });

      bundle.pageData = pageDataRecord;

      // Crawler document ONLY: `deferredKeys`/`deferredSettlements` stay
      // exactly as an ordinary streamed `defer()` page leaves them, so the
      // SAME downstream stops that already serve that page —
      // `buildHydrationPayload`'s `deferred` list and
      // `wrapPipeableStreamForDeferredEmission`'s `__WARLOCK_DEFER__`
      // chunk, both below — settle these keys through the document-scope
      // registry (`client/runtime/defer-registry.ts`) a second time, this
      // time for the client. A JS-executing crawler's hydration then reads
      // an already-fulfilled promise instead of the raw value `use()`
      // cannot accept — no second mechanism, the one streaming already has.
      if (dataRequest) {
        restoreInlineDeferredForDataWire = () => {
          deferredKeys.forEach((key, index) => {
            pageDataRecord[key] = (settled[index] as { ok: true; value: unknown }).value;
          });
          bundle.deferredKeys = undefined;
          // RELEASE BLOCKER fix: keep the key list on the bundle, under a
          // separate name, so `buildHydrationPayload` can still mark these
          // keys `deferred` on the wire even though the value sitting in
          // `pageData` is now a plain, resolved one rather than a live
          // Promise — `wirePageData` must not delete it (it is JSON-safe and
          // is the actual answer), but the client still needs to know it was
          // deferred, so it wraps it in an already-fulfilled thenable before
          // `use()` reads it (`fetch-page-data.ts`). See
          // `PageDataBundle.inlinedDeferredKeys`'s own doc.
          bundle.inlinedDeferredKeys = deferredKeys;
        };
      }
    } else {
      // Reconstruct a throwable from the wire-shape settlement error so this
      // reaches `buildErrorRecord` exactly the way an ordinary page-loader
      // throw would — same shape, same designation, same rendering below.
      const failure = settled[rejectedIndex] as DeferSettlement & { ok: false };
      const reconstructed = new Error(failure.error.message) as Error & { statusCode?: number };

      reconstructed.name = failure.error.name;
      if (failure.error.statusCode !== undefined) {
        reconstructed.statusCode = failure.error.statusCode;
      }

      bundle.error = buildErrorRecord(
        reconstructed,
        designateBoundary("page", triple),
        bundle.route.path,
        failure.error.statusCode,
        {
          routeName: bundle.route.name,
          routePath: bundle.route.path,
          method: request.method,
          requestId: request.id,
        },
      );
      bundle.deferredKeys = undefined;

      // The rejected key never got a wire-safe value — leaving its live
      // (rejected) promise sitting in `pageData` would hand
      // `buildHydrationPayload` something devalue rightly refuses to
      // serialize (a class instance is the named case; a stray Promise is
      // exactly as un-serializable). The page is escalating to the error
      // boundary regardless, so `pageData` only needs to stay a valid wire
      // object, not carry a value nothing downstream will read.
      const pageDataRecord = (bundle.pageData ?? {}) as Record<string, unknown>;

      for (const key of deferredKeys) delete pageDataRecord[key];

      bundle.pageData = pageDataRecord;
    }
  }

  // `Cache-Control` is NOT decided here. The final value — the floor, an
  // opted-in route's `public, max-age`, or the closed-by-default `no-store` —
  // is decided once, at the `create-page-route-handler.ts` seam, by
  // `applyResponseCacheFloor` (`response-cache-floor.ts`), identically for the
  // document and the data representation. Anything this function's `headers`
  // map put under `cache-control` is overwritten there on purpose: two sites
  // deciding this key is exactly the drift that seam exists to prevent.

  // "render.shell" tracing phase: from here — the start of the
  // actual render work — until React's shell is ready to pipe, just below.
  // Resolved once; a disabled app pays one boolean check and never starts a
  // timer.
  const tracingEnabled = isTracingEnabled();
  const renderShellStartedAt = tracingEnabled ? performance.now() : 0;

  // ── stage 9 · RENDER ─────────────────────────────────────────────────────
  // Lazy import: react-dom is a peer used only on this path, so merely
  // loading the server barrel never requires it.
  const { renderToString } = await import("react-dom/server");

  // JSON.stringify omits object properties whose value is undefined. Loader
  // `<Head/>`/`<Scripts/>` read this context — metadata and the payload are
  // both already final by this point (stages 1-8 are done), so there is
  // nothing left for the root to await.
  //
  // The payload comes from `buildHydrationPayload` rather than being assembled
  // here, so that this document and the `_loader` route hand the browser the
  // SAME object. See that module for why the two must not drift.
  // Stage 8 already resolved the page's own metadata; this overrides only
  // `robots`, and only for the route that asked (the not-found page). Every
  // error path below replaces `bundle.metadata` with its own noindex answer.
  if (streamOptions.noindex === true) {
    bundle.metadata = { ...bundle.metadata, robots: "noindex" };
  }

  // Design note §D.2: emitted on every locale-routed page, independent of the
  // page's own `metadata.canonical`. A localized page is canonical to itself
  // and still lists its hreflang siblings; `localizedPath()` builds that
  // self-canonical (see `DocumentContextValue.localeAlternates`).
  const activeLocaleRouting = readLocaleRouting();
  const localeAlternates = resolveLocaleAlternates(
    request.path,
    bundle.route.path,
    activeLocaleRouting,
    getPublicUrl(),
  );
  // RELEASE BLOCKER fix: the runtime table the browser must hydrate with,
  // not the build-time `virtual:warlock/pages` guess — see
  // `DocumentContextValue.localeRouting`.
  const localeRouting = resolveDocumentLocaleRouting(bundle.route.path, activeLocaleRouting);

  let documentValue: DocumentContextValue = {
    metadata: bundle.metadata,
    payload: buildHydrationPayload(bundle, documentSlots.locale),
    nonce: documentSlots.nonce,
    lang: documentSlots.locale,
    stylesheetUrls: documentStylesheetUrls(
      streamOptions.stylesheetUrls,
      requestStylesheetSources(request),
      streamOptions.resolveRequestStylesheetUrls,
    ),
    hydrationClientModuleUrl: streamOptions.hydrationClientModuleUrl,
    hydrationClientModulePreloadUrls: streamOptions.hydrationClientModulePreloadUrls,
    localeAlternates,
    localeRouting,
    namedApiRoutes: resolveNamedApiRoutes(),
  };

  const wrapWithContext = (element: ReactNode): ReactNode =>
    createElement(DocumentContext.Provider, {
      value: documentValue,
      children: createElement(LocaleProvider, {
        locale: documentValue.payload.locale,
        translations: bundle.routeTranslations?.keywords,
        children: element,
      }),
    });

  // Records the LAST wrapped element every `renderWithContext` call rendered
  // — read after the escalation loop below settles, to feed the second,
  // streaming render pass (`renderElementToPipeableStream`). A `let`, read by
  // closure rather than snapshotted, so it always reflects whichever
  // `documentValue` was live at the moment it was wrapped (error-page
  // fallbacks reassign `documentValue` and re-wrap before rendering again).
  let finalWrappedElement: ReactNode;

  const renderWithContext = (element: ReactNode): string => {
    finalWrappedElement = wrapWithContext(element);
    return renderToString(finalWrappedElement);
  };

  // A boundary that throws while rendering escalates to
  // the next enclosing boundary rootward; if none survives, the framework's
  // last-resort terminal renders. `currentError` starts as whatever stage
  // 1-8 already designated (`bundle.error`, undefined for a normal page
  // render) and is replaced by each escalation — `bundle.error` itself is
  // never mutated, staying a truthful stage 1-8 record.
  let currentError = bundle.error;
  let renderTimeThrow = false;
  let body: string;

  const renderFrameworkRoot = (): string => {
    bundle.routeTranslations = bindRequestRouteTranslations(
      request,
      streamOptions.getRouteTranslations,
      streamOptions.appFile,
    );
    documentValue = {
      ...documentValue,
      payload: buildHydrationPayload(bundle, documentSlots.locale),
    };
    return renderWithContext(
      createElement(DefaultApp, {
        children: strictPageTree(triple.app, createElement(FrameworkRootBoundary, {})),
      }),
    );
  };
  const renderFrameworkAfterErrorPageFailure = (): string => {
    bundle.errorPage = undefined;
    bundle.metadata = ERROR_PAGE_METADATA;
    documentValue = {
      ...documentValue,
      metadata: bundle.metadata,
      payload: buildHydrationPayload(bundle, documentSlots.locale),
    };
    return renderFrameworkRoot();
  };

  const renderErrorPage = async (
    thrown: unknown,
    serializableError: unknown = thrown,
  ): Promise<string | undefined> => {
    if (!loadErrorPage) return undefined;
    bundle.routeTranslations = bindRequestRouteTranslations(
      request,
      streamOptions.getRouteTranslations,
      streamOptions.errorPageFile ?? streamOptions.appFile,
    );

    // The status is the FAILURE's own — 500 for an ordinary escalated throw,
    // but a `route.validate` rejection carries its own 400
    // (`PageErrorRecord.statusCode`, canon `b79c4f55`, point 2) and the error
    // page must receive that, not a blanket 500.
    const props: ServerErrorPageProps = { error: thrown, status: currentError?.statusCode ?? 500 };
    const module = await loadErrorPage();
    registerModules([module as RegisterableModuleNamespace]);
    // Prefer the digest `buildErrorRecord` already logged for THIS error
    // (`console.error("[warlock] page error", digest, ...)`) so the browser's
    // `errorCode` joins that exact line; fall back to the request id only
    // when there is no such digest (the app-boundary-itself-threw path below,
    // where `thrown` never went through `buildErrorRecord`).
    const errorPage = hydrationErrorPageProps(
      props,
      serializableError,
      currentError?.digest ?? request.id,
    );
    bundle.errorPage = errorPage;
    const ssrProps = resolveServerErrorPageProps(props, errorPage);
    bundle.metadata = resolveErrorPageMetadata(module, ssrProps);
    documentValue = {
      ...documentValue,
      metadata: bundle.metadata,
      payload: buildHydrationPayload(bundle, documentSlots.locale),
    };
    return renderWithContext(
      wrapRootward(triple, bundle, "page", errorPageElement(module, ssrProps)),
    );
  };

  for (;;) {
    try {
      // The application error page is the framework terminal, never a rival
      // to an authored boundary. It is reached only after no app boundary
      // exists (or after that boundary has itself thrown below).
      if (currentError?.boundary.boundaryLevel === "app" && !triple.app.ErrorBoundary) {
        try {
          body =
            (await renderErrorPage(
              currentError.originalError ?? currentError.error,
              currentError.error,
            )) ?? renderFrameworkRoot();
        } catch (errorPageThrown) {
          reportErrorPageFailure(bundle.route, errorPageThrown, request);
          body = renderFrameworkAfterErrorPageFailure();
        }
        renderTimeThrow = true;
        break;
      }

      const element = currentError
        ? buildBoundaryElement(triple, bundle, currentError)
        : buildPageElement(triple, bundle);

      body = renderWithContext(element);
      break;
    } catch (thrown) {
      renderTimeThrow = true;

      // Floor first: whatever we do next (escalate to a boundary, fall to the
      // framework terminal), the throw must not vanish. See reportRenderError.
      reportRenderError(bundle.route, thrown, request);

      if (currentError?.boundary.boundaryLevel === "app") {
        // The floor: the app-level boundary's own render just threw, so
        // there is nothing rootward of `app` to escalate to. Render the
        // framework's trivial boundary directly —
        // bypassing the app's ErrorBoundary/App component, since that is
        // what just failed — wrapped in DefaultApp so the response is still
        // a complete `<html>` document (default-app.tsx:22-46) rather than
        // a bare `<main>` fragment.
        try {
          body = (await renderErrorPage(thrown)) ?? renderFrameworkRoot();
        } catch (errorPageThrown) {
          reportErrorPageFailure(bundle.route, errorPageThrown, request);
          body = renderFrameworkAfterErrorPageFailure();
        }
        break;
      }

      // Escalate from the level rootward of whatever just threw — searching
      // from the SAME level would re-select the boundary that just failed.
      // A throw not yet attributable to a level (a normal page render, no
      // prior designation) starts the search at `page`.
      const throwingLevel: PageLevelName =
        currentError?.boundary.boundaryLevel === "layout"
          ? "app"
          : currentError
            ? "layout"
            : "page";

      currentError = buildErrorRecord(
        thrown,
        designateBoundary(throwingLevel, triple),
        bundle.route.path,
        undefined,
        {
          routeName: bundle.route.name,
          routePath: bundle.route.path,
          method: request.method,
          requestId: request.id,
        },
      );
    }
  }

  // Status is chosen after render — the last thing that can change the
  // outcome — and RETURNED, never applied: `finishRender` writes the live
  // response zero times. The caller applies status + headers at one site and
  // flushes immediately after (stage 10a/10b). "The framework owns the status
  // whenever a boundary renders" (design/request-lifecycle.md stage 7): ANY
  // boundary — nested or app-level, discovered pre-render or escalated during
  // render — forces 500, UNLESS the failure carries its own status
  // (`PageErrorRecord.statusCode` — a `route.validate` rejection's 400, canon
  // `b79c4f55` point 2). The boundary's LEVEL only decides which component
  // renders; the committed status from stage 7
  // (`bundle.commit.statusCode`) stands only for a page with no error at all
  // — read off the commit, never off the live `response`, same as `headers`
  // above. No committed status (no loader called `setStatusCode`) is the
  // ordinary 200.
  const status = currentError
    ? (currentError.statusCode ?? 500)
    : ((bundle as Bundle).commit?.statusCode ?? 200);

  const html = emitDocument(body);

  // Crawler mode forces `onAllReady` regardless of the caller's own
  // `waitForAll` — decision 2's "wait for React's onAllReady before the
  // first byte", since nothing has flushed yet and a crawler must receive
  // the fully resolved document, never a shell it cannot observe the rest
  // of.
  const waitForAll = streamOptions.waitForAll || streamOptions.crawler === true;

  // Stage 9's second pass: the element above just proved safe to render (the
  // escalation loop ran it to completion, synchronously, with no throw) —
  // stream THAT SAME element for the bytes that actually reach the client.
  // See `renderElementToPipeableStream` and `RenderedPage.pipeableStream`.
  const { pipeableStream: renderedStream, allReady } = await renderElementToPipeableStream(
    finalWrappedElement,
    waitForAll,
    bundle.route,
    documentSlots.nonce,
    request,
  );

  // React's shell is ready to pipe the instant `renderElementToPipeableStream`
  // resolves (`onShellReady`, or `onAllReady` when `waitForAll` is set) — the
  // phase closes here, before the deferred-emission wrapping below, which is
  // no longer part of "render", it is streaming.
  if (tracingEnabled) {
    dispatchPhase(buildTracingContext(request), {
      name: "render.shell",
      durationMs: performance.now() - renderShellStartedAt,
    });
  }

  // The data-request inline path's own wire restore (see where it is set,
  // above): both render passes above (the escalation loop's synchronous
  // proof pass, and the streaming pass just above) have already read
  // `bundle.pageData` — with the settled thenable in place, neither ever
  // suspended on it — so it is safe to put the plain value back now, before
  // anything downstream builds the actual JSON body this request answers
  // with.
  restoreInlineDeferredForDataWire?.();

  // Stage 2: a page with deferred keys gets its stream wrapped so each
  // settlement writes a `__WARLOCK_DEFER__` chunk after the shell has
  // flushed, and the response ends only once every key has settled AND
  // `onAllReady` has fired (contract rules 5, 6, 9). A page with none gets
  // `renderedStream` back completely untouched — see `defer-emission.ts`.
  const deferredKeys = bundle.deferredKeys ?? [];

  // A page with no deferred keys skips `wrapPipeableStreamForDeferredEmission`
  // entirely (below), so it never gets that wrapper's own client-disconnect
  // wiring — without this, only `@warlock.js/core`'s own raw-socket listener
  // (`stream-react-response.ts`) would ever abort this stream, and it calls
  // `abort()` with no reason, which is exactly the "aborted ... without a
  // reason" SSR-error report card 0d43c0d6 closes. Aborting HERE, on the
  // SAME per-request signal, fires first (this listener is attached before
  // `response.streamReact` ever runs) and stamps the recognisable reason —
  // React clears its abortable-task set on the first `abort()` call, so
  // core's later, reasonless `abort()` becomes a no-op and never re-fires
  // `onError`.
  //
  // Deliberately NOT checked for "already aborted" at this point: this same
  // signal also doubles as the loader-chain's own cancellation switch
  // (`execute-page-request.ts`'s `requestAbortController.abort()` on a
  // `web.loaderTimeout` breach) and can already be aborted here for THAT
  // reason by the time an error page reaches this render call — mislabelling
  // and killing that render would be a regression, not a fix. A loader
  // timeout always fires before this render call starts, so a genuinely NEW
  // `"abort"` event from this point on can only be the real-disconnect
  // listener (`request-abort-signal.ts`) firing during streaming.
  if (deferredKeys.length === 0 && bundle.abortSignal !== undefined) {
    bundle.abortSignal.addEventListener(
      "abort",
      () => renderedStream.abort(new ClientDisconnectedError()),
      { once: true },
    );
  }

  const pipeableStream =
    deferredKeys.length === 0
      ? renderedStream
      : wrapPipeableStreamForDeferredEmission({
          pipeableStream: renderedStream,
          deferred: deferredKeys.map((key) => ({
            key,
            settlement:
              bundle.deferredSettlements?.[key] ??
              Promise.resolve<DeferSettlement>({ ok: true, value: undefined }),
          })),
          nonce: documentSlots.nonce,
          allReady,
          routeName: bundle.route.name,
          routePath: bundle.route.path,
          pathname: pathnameFromRequest(request),
          method: request.method,
          requestId: request.id,
          signal: bundle.abortSignal,
        });

  return {
    html,
    status,
    headers,
    cookies,
    data: bundle.pageData,
    bundle,
    pipeableStream,
    usesDefer,
  };
}

/**
 * Render failures that happen before the page pipeline has a triple (notably a
 * module-load or registration throw). This deliberately owns one terminal
 * attempt: an error-page failure falls straight to FrameworkRootBoundary.
 *
 * There is no triple yet, so there is no trustworthy server composition for
 * the browser to hydrate against — every response this function produces is
 * marked `markNonHydrating` (page-render-bundle.ts), on both the bundle and
 * the document payload, whether or not it managed to render the app's own
 * `error.page.tsx`. A normal app error page reached through `finishRender`
 * renders inside a real triple and stays hydratable; this path never does.
 *
 * Deliberately still `renderToString`, not streamed: this is the ONE
 * terminal attempt at a module-load/registration failure, already
 * exceptional and rare, and
 * there is no real triple behind it for a second, streaming render pass to
 * prove safe the way `finishRender`'s escalation loop does for every other
 * document. Buffering the one attempt this function ever makes costs nothing
 * a real page request would notice.
 */
export async function renderPageFailure(options: RenderPageFailureOptions): Promise<RenderedPage> {
  const { request, response, name, path, thrown, loadErrorPage } = options;
  const bundle: PageDataBundle = markNonHydrating({
    route: { name, path, params: {}, query: {} },
    ...(options.routeTranslations === undefined
      ? {}
      : { routeTranslations: options.routeTranslations }),
  });
  // No pipeline ran (there is no triple), so there is no commit to read —
  // never a live `response.getHeaders()` read either; see `finishRender`.
  const headers: Record<string, string> = { "cache-control": "private" };

  const { renderToString } = await import("react-dom/server");
  const slots = documentSlotsFrom({ request, response });
  const frameworkPayload = markNonHydrating(buildHydrationPayload(bundle, slots.locale));
  let value: DocumentContextValue = {
    metadata: undefined,
    payload: frameworkPayload,
    nonce: slots.nonce,
    lang: slots.locale,
    stylesheetUrls: options.stylesheetUrls,
    hydrationClientModuleUrl: options.hydrationClientModuleUrl,
    // Same reasoning as `finishRender` — a module-load/registration failure
    // still owes the browser the runtime routing table, not the build-time
    // guess, or `<Link>`/`changeLocaleCode` go dead on this document too.
    localeRouting: resolveDocumentLocaleRouting(path, readLocaleRouting()),
  };
  const renderWithContext = (element: ReactNode): string =>
    renderToString(
      createElement(DocumentContext.Provider, {
        value,
        children: createElement(LocaleProvider, {
          locale: value.payload.locale,
          translations: bundle.routeTranslations?.keywords,
          children: element,
        }),
      }),
    );
  let body: string;

  try {
    if (!loadErrorPage) throw new Error("No application error page is configured.");
    const props: ServerErrorPageProps = { error: thrown, status: 500 };
    const module = await loadErrorPage();
    bundle.routeTranslations = bindRequestRouteTranslations(
      request,
      options.getRouteTranslations,
      options.errorPageFile ?? options.appFile ?? "",
    );
    registerModules([module as RegisterableModuleNamespace]);
    const errorPage = hydrationErrorPageProps(props, undefined, request.id);
    bundle.errorPage = errorPage;
    // Same chokepoint as `renderErrorPage` above: production SSR must render
    // the sanitized error, matching the hydration payload set below.
    const ssrProps = resolveServerErrorPageProps(props, errorPage);
    value = {
      ...value,
      metadata: resolveErrorPageMetadata(module, ssrProps),
      payload: markNonHydrating({ ...buildHydrationPayload(bundle, slots.locale), errorPage }),
    };
    body = renderWithContext(
      createElement(DefaultApp, { children: errorPageElement(module, ssrProps) }),
    );
  } catch (errorPageThrown) {
    if (loadErrorPage) reportErrorPageFailure(bundle.route, errorPageThrown, request);
    bundle.errorPage = undefined;
    bundle.routeTranslations = bindRequestRouteTranslations(
      request,
      options.getRouteTranslations,
      options.appFile ?? "",
    );
    bundle.metadata = ERROR_PAGE_METADATA;
    value = {
      ...value,
      metadata: bundle.metadata,
      payload: markNonHydrating(buildHydrationPayload(bundle, slots.locale)),
    };
    body = renderWithContext(
      createElement(DefaultApp, {
        children: createElement(FrameworkRootBoundary, {}),
      }),
    );
  }

  return {
    html: emitDocument(body),
    status: 500,
    headers,
    cookies: [],
    data: undefined,
    bundle,
  };
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/**
 * The production render surface: a real HTTP server has a URL. The url goes
 * STRAIGHT to executePageRequest's stage-1 matcher, then the shared tail
 * (`finishRender`) renders and emits.
 *
 * No-match is not thrown on: an arbitrary URL matching no route is a
 * legitimate 404, and a server must ANSWER it — `{ html: "", status: 404 }`
 * with an undefined `bundle` (see RenderedPage).
 */
export async function renderPageRequest(
  url: string,
  options: RenderPageRequestOptions,
): Promise<RenderedPage | Response> {
  const registry = requireRegistry(options);
  const { state, createHttp: captureHttp } = capturingCreateHttp(registry);
  const createHttp: ExecutePageRequestOptions["createHttp"] = (match) => {
    const context = captureHttp(match);
    if (options.pageFile !== undefined) {
      bindRequestRouteTranslations(context.request, options.getRouteTranslations, options.pageFile);
    }
    return context;
  };

  const rendered = await executePageRequest({
    url,
    routes: registry.routes,
    matched: options.matched,
    createHttp,
    finish: (bundle) => {
      if (options.getRouteTranslations !== undefined && options.pageFile !== undefined) {
        bundle.routeTranslations = options.getRouteTranslations(
          options.pageFile,
          state.captured!.request.locale,
        );
      } else if (options.routeTranslations !== undefined) {
        bundle.routeTranslations = options.routeTranslations;
      }

      return finishRender(
        state.match!.entry.triple,
        bundle,
        documentSlotsFrom(state.captured),
        state.captured!.response,
        state.captured!.request,
        options.loadErrorPage,
        options.dataRequest ?? false,
        {
          stylesheetUrls: options.stylesheetUrls,
          hydrationClientModuleUrl: options.hydrationClientModuleUrl,
          hydrationClientModulePreloadUrls: options.hydrationClientModulePreloadUrls,
          resolveRequestStylesheetUrls: options.resolveRequestStylesheetUrls,
          waitForAll: options.waitForAll ?? false,
          awaitDeferredForDataRequest: options.awaitDeferredForDataRequest,
          crawler: options.crawler,
          noindex: options.noindex,
          getRouteTranslations: options.getRouteTranslations,
          appFile: options.appFile ?? "",
          errorPageFile: options.errorPageFile,
        },
      );
    },
  });

  if (!rendered) {
    return {
      html: "",
      status: 404,
      headers: {},
      cookies: [],
      data: undefined,
      bundle: undefined,
    };
  }

  // executePageRequest only produces a bundle after createHttp ran for the
  // match, so the captured entry is present whenever the bundle is.
  return rendered;
}
