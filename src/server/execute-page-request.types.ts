import type { BaseValidator } from "@warlock.js/seal";
import type { WebRequest } from "../context";
import type { SharedContext } from "../index";
import type { MetadataOutput, PageMetadata } from "../metadata";
import type { SharedStore } from "../shared";
import type { BufferedCookie, BufferedHeader, BufferedWebResponse } from "./buffered-response";

/** At runtime this IS core's `RequestContextStore` (request-context.ts:10-13). */
export type PipelineStore = SharedStore & {
  request: unknown;
  response: unknown;
};

/**
 * Core's `requestContext` satisfies this as-is — `run`/`getStore` are the
 * inherited `Context` delegates and `buildStore` is `RequestContext.buildStore`,
 * the same function core's http path feeds through `contextManager.buildStores`.
 */
export type PageContextRunner = {
  run<T>(store: PipelineStore, callback: () => Promise<T>): Promise<T>;
  getStore(): PipelineStore | undefined;
  buildStore?(payload?: Record<string, any>): PipelineStore;
};

export type PageLevelName = "app" | "layout" | "page";

/**
 * The request members the pipeline touches, declared explicitly rather than
 * imported from core: `WebRequest` is the loader-facing minimal facade and does
 * not carry the validation sources.
 *
 * `query`/`params` are core's own parses (request.ts:1010,1026) and the ONLY
 * ones the pipeline reads. Stage 4 used to take them from a match object built
 * by re-parsing the URL — `resolve-validation-data.ts` records what that cost.
 */
export type PipelineRequest = WebRequest & {
  body?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  setValidatedData?(data: Record<string, unknown>): void;
};

/**
 * Standalone rather than based on `WebResponse`: that facade's
 * `redirect`/`notFound` return the branded short-circuit signal, which core's
 * real `Response` never carries — basing this on it would reject the very
 * instances the seam exists to admit.
 */
export type PipelineResponse = {
  header(key: string, value: string): PipelineResponse;
  cookie(name: string, value: unknown, options?: Record<string, unknown>): PipelineResponse;
  setStatusCode(statusCode: number): PipelineResponse;
  parse(value: unknown): Promise<unknown>;
};

/** Pass-through is `undefined` — core's exact rule (`Request.executeMiddleware`). */
export type PipelineMiddleware = (ctx: {
  request: PipelineRequest;
  response: PipelineResponse;
}) => unknown | Promise<unknown>;

export type PipelineLoader = (ctx: {
  request: PipelineRequest;
  response: BufferedWebResponse;
  shared: SharedContext;
}) => unknown | Promise<unknown>;

/** The server half of a page/layout/App module. */
export type PageTripleModule = {
  route?: string | { readonly path: string; readonly name?: string };
  middleware?: readonly PipelineMiddleware[];
  validation?: { schema?: BaseValidator; validating?: readonly string[] };
  loader?: PipelineLoader;
  metadata?: PageMetadata<PipelineLoader>;
  /** Runs-twice half — carried through untouched; the render slice consumes them. */
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
};

export type PageRouteMatch = {
  entry: PageRouteEntry;
  params: Record<string, string>;
  query: Record<string, string>;
};

export type ExecutePageRequestOptions<TResult = PageDataBundle> = {
  /** Path + optional query string, e.g. `/products/42?tab=specs`. */
  url: string;
  routes: readonly PageRouteEntry[];
  /**
   * Construct the Request/Response pair for this match, mirroring core's
   * `handleRoute` body (router.ts:924-932).
   */
  createHttp(match: PageRouteMatch): { request: PipelineRequest; response: PipelineResponse };
  /**
   * The render seam — continues stages 9-10 inside the exact ALS store and
   * shared scope that middleware and loaders used.
   */
  finish?(bundle: PageDataBundle): TResult | Promise<TResult>;
};

export type PageBoundaryDesignation = {
  throwingLevel: PageLevelName;
  /** Nearest boundary at or rootward of the throw; `app` is the terminal fallback. */
  boundaryLevel: PageLevelName;
};

export type PageResponseCommit = {
  /** Final per-key state, root→leaf: a leafward write wins its key. */
  headers: BufferedHeader[];
  cookies: BufferedCookie[];
  statusCode?: number;
  committedLevels: PageLevelName[];
};

export type PageShortCircuit =
  | {
      stage: "middleware";
      level: PageLevelName;
      value: unknown;
      /** Captured at stage 3, so `finishRender` stays a pure function of (triple, bundle). */
      statusCode?: number;
    }
  | { stage: "validation"; status: number; errors: unknown }
  | {
      stage: "loaders";
      level: PageLevelName;
      kind: "redirect" | "notFound";
      statusCode: number;
      url?: string;
      body?: unknown;
    };

/**
 * What a throw becomes once it enters the bundle. `scrubbed` says whether
 * `error` is the raw thrown value or a production surrogate standing in for it.
 */
export type PageErrorRecord = {
  error: unknown;
  boundary: PageBoundaryDesignation;
  digest: string;
  scrubbed: boolean;
};

export type PageDataBundle = {
  route: {
    name: string;
    path: string;
    params: Record<string, string>;
    /**
     * ⚠ Re-parsed from the URL by `match-page-route.ts`, NOT core's parse, so it
     * is flat and last-wins: `?tags=a&tags=b&filter[status]=active` arrives as
     * `{ tags: "b", "filter[status]": "active" }`.
     *
     * Nothing in `web` reads it — stage 4 was the last consumer. It survives
     * only as part of this public type and goes away with the second matcher.
     * **Read `request.query`.**
     */
    query: Record<string, string>;
  };
  appData?: unknown;
  layoutData?: unknown;
  pageData?: unknown;
  /** `sealShared()`'s RETURN — the sealed target, never a proxy re-read. */
  shared?: Readonly<SharedContext>;
  metadata?: MetadataOutput;
  commit?: PageResponseCommit;
  shortCircuit?: PageShortCircuit;
  error?: PageErrorRecord;
};
