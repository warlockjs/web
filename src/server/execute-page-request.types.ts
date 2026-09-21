import type { HttpContext, Request, Response } from "@warlock.js/core";
import type { BaseValidator } from "@warlock.js/seal";
import type { SharedContext } from "../index";
import type { MetadataOutput, PageMetadata } from "../metadata";
import type { SerializedErrorPageProps } from "../components/document-context";
import type { SharedStore } from "../shared";
import type { DeferSettlement } from "./defer-settlement";
import type { BufferedResponse } from "./settle-page-response";
import type { RouteTranslations } from "./route-translations";

export type PipelineStore = SharedStore & {
  request: Request;
  response: Response;
};

export type PageContextRunner = {
  run<T>(store: PipelineStore, callback: () => Promise<T>): Promise<T>;
  getStore(): PipelineStore | undefined;
  buildStore?(payload?: Record<string, any>): PipelineStore;
};

export type PageLevelName = "app" | "layout" | "page";

export type PipelineMiddleware = (ctx: HttpContext) => unknown | Promise<unknown>;

/**
 * A loader never sees the live `Response` — stage 6 hands it a per-level
 * `BufferedResponse` (`execute-page-request.ts`, `createBufferedResponse`),
 * so its own type says that, rather than the core `Response` a middleware
 * receives.
 */
export type PipelineLoaderContext = {
  request: Request;
  response: BufferedResponse;
  shared: SharedContext;
  /**
   * Fires when the underlying HTTP request is abandoned (client
   * disconnected, socket closed) before the response finished — see
   * `request-abort-signal.ts`.
   *
   * A loader that ignores this signal runs to completion: the framework
   * only stops the pipeline BETWEEN levels (app → layout → page), never
   * inside a loader that is already running. Hand it to anything
   * cancelable (`fetch(url, { signal })`) if an abandoned request should
   * stop that work early; nothing breaks if you don't.
   */
  signal: AbortSignal;
};

export type PipelineLoader = (ctx: PipelineLoaderContext) => unknown | Promise<unknown>;

export type PageTripleModule = {
  register?: () => unknown;
  route?:
    | string
    | {
        readonly path: string;
        readonly name?: string;
        /** A Seal object schema validated against `{ params, query }` — `route.ts`'s `RouteDeclaration`. */
      };
  /** This page's own guards, run LAST — see `LEVEL_ORDER` below. */
  middleware?: readonly PipelineMiddleware[];
  validation?:
    | { schema?: BaseValidator; validating?: readonly string[]; params?: never; query?: never }
    | { params?: BaseValidator; query?: BaseValidator; schema?: never; validating?: never };
  loader?: PipelineLoader;
  metadata?: PageMetadata<PipelineLoader>;
  default?: unknown;
  ErrorBoundary?: unknown;
};

export type PageRouteEntry = {
  path: string;
  name: string;
  triple: {
    app: PageTripleModule;
    layout: PageTripleModule;
    page: PageTripleModule;
  };
  /**
   * The page's own-directory `layout.tsx` file, when the route has one —
   * threaded through from `create-page-route-handler.ts`'s `layoutFile`
   * purely so the "loader" tracing phase can report which
   * layout ran, without every test-constructed `PageRouteEntry` having to
   * know about it (it stays `undefined`, and the attribute is simply
   * omitted).
   */
  layoutPath?: string;
};

export type PageRouteMatch = {
  entry: PageRouteEntry;
  params: Record<string, string>;
  query: Record<string, string>;
};

export type ExecutePageRequestOptions<TResult = PageDataBundle> = {
  url: string;
  routes: readonly PageRouteEntry[];
  /**
   * An HTTP router has already selected this entry and decoded its params.
   * Supplying it prevents the page pipeline from matching the same URL again;
   * callers without an HTTP request continue to resolve against `routes`.
   */
  matched?: Pick<PageRouteMatch, "entry" | "params">;
  createHttp(match: PageRouteMatch): HttpContext;
  finish?(bundle: PageDataBundle): TResult | Promise<TResult>;
};

export type PageBoundaryDesignation = {
  throwingLevel: PageLevelName;
  boundaryLevel: PageLevelName;
};

export type PageShortCircuit =
  | {
      stage: "middleware";
      level: PageLevelName;
      value: unknown;
      statusCode?: number;
      /**
       * `Response.sent`, read at the moment the short-circuit was recorded —
       * true when the middleware already wrote the real HTTP reply itself
       * (`response.redirect()`, `response.forbidden()`, any call that reaches
       * `Response.send()`). A full-document render must never re-render a
       * body when this is true: the wire already carries the real answer, and
       * a second write would only hit `Response.send()`'s own already-sent
       * guard. See `render-page.ts`'s `finishRender`.
       */
      responseSent?: boolean;
    }
  | { stage: "validation"; status: number; errors: unknown }
  | {
      /**
       * An app, layout or page LOADER returned `response.redirect()`,
       * `permanentRedirect()` or `notFound()`. Recorded at stage 6 and never
       * sent by the loader itself: the handler writes the answer — the
       * redirect's `Location`, or the not-found document on a full-document
       * request (`create-page-route-handler.ts`).
       */
      stage: "loaders";
      level: PageLevelName;
      kind: "redirect" | "notFound";
      statusCode: number;
      url?: string;
      body?: unknown;
    };

export type PageErrorRecord = {
  /** Never serialized; preserves the actual thrown value for server error.page.tsx. */
  originalError: unknown;
  error: unknown;
  boundary: PageBoundaryDesignation;
  digest: string;
  scrubbed: boolean;
  /**
   * Undefined means the pipeline's ordinary answer to any escalated failure:
   * 500. Set only by a failure that OWNS its own status — today, a
   * `route.validate` rejection's 400 (canon `b79c4f55`, point 2: the visitor's
   * malformed input, never the server's fault).
   */
  statusCode?: number;
};

export type PageDataBundle = {
  route: {
    name: string;
    path: string;
    params: Record<string, string>;
    query: Record<string, string>;
  };
  appData?: unknown;
  layoutData?: unknown;
  pageData?: unknown;
  shared?: Readonly<SharedContext>;
  metadata?: MetadataOutput;
  shortCircuit?: PageShortCircuit;
  error?: PageErrorRecord;
  /** Immutable route-owned translations selected for this request. */
  routeTranslations?: RouteTranslations;
  /**
   * Selected only for the framework-owned application error-page terminal —
   * already the JSON-safe shape (`hydrationErrorPageProps` produces this, not
   * the raw `ErrorPageProps` an authored `error.page.tsx` renders from during
   * SSR), because this field's only consumer is the hydration payload
   * (`build-hydration-payload.ts`), never a component prop.
   */
  errorPage?: SerializedErrorPageProps;
  /**
   * Top-level PAGE loader keys returned as promises via `defer()`, in
   * declaration order. Undefined for a page that never called `defer()` —
   * `build-hydration-payload.ts` reads this to know which `pageData` keys to
   * omit from the wire and to add the payload's own `deferred` list.
   */
  deferredKeys?: string[];
  /**
   * Top-level PAGE loader keys that WERE deferred but have already been
   * awaited and inlined back into `pageData` as plain, resolved values — set
   * by `render-page.ts`'s data-request/crawler await-and-inline path
   * (`restoreInlineDeferredForDataWire`) once `deferredKeys` itself is
   * cleared, so the two fields are never simultaneously non-empty for the
   * same bundle. `build-hydration-payload.ts` reads this ALONGSIDE
   * `deferredKeys` to build the wire's `deferred` list: unlike a genuinely
   * streamed key, an inlined key's `pageData[key]` is a real, JSON-safe value
   * and must stay on the wire — only the marker is needed, so the client
   * (`fetch-page-data.ts`'s plain-JSON path) knows to wrap it in an
   * already-fulfilled thenable before `use()` ever sees it (RELEASE
   * BLOCKER — a resolved deferred value on a serverCache route's JSON
   * representation used to reach `use()` as a bare value, "Minified React
   * error #438").
   */
  inlinedDeferredKeys?: string[];
  /**
   * INTERNAL ONLY — one settlement promise per deferred key, keyed by name.
   * Never read by `build-hydration-payload.ts` (it is not JSON-safe: it is a
   * live `Promise`, not wire data) — `render-page.ts`'s `finishRender` reads
   * it to know when each key settles, to emit its chunk script in settlement
   * order and to gate the response end on every key having settled (contract
   * rules 5 and 9).
   */
  deferredSettlements?: Record<string, Promise<DeferSettlement>>;
  /**
   * The SAME per-request signal `PipelineLoaderContext.signal` carries —
   * `request-abort-signal.ts`'s one controller per request, fires when the
   * client disconnects before the response finished. Carried on the bundle
   * so the streaming writers reached after `finish()` (`render-page.ts`'s
   * `finishRender`, `write-deferred-ndjson-response.ts`) can subscribe to
   * the SAME signal loaders already read, rather than a second one (card
   * a84d0644).
   */
  abortSignal?: AbortSignal;
};
