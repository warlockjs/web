import type { HttpContext, Request, Response } from "@warlock.js/core";
import type { BaseValidator } from "@warlock.js/seal";
import type { SharedContext } from "../index";
import type { MetadataOutput, PageMetadata } from "../metadata";
import type { SerializedErrorPageProps } from "../components/document-context";
import type { SharedStore } from "../shared";
import type { BufferedResponse } from "./settle-page-response";

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
};

export type PipelineLoader = (ctx: PipelineLoaderContext) => unknown | Promise<unknown>;

export type PageTripleModule = {
  register?: () => unknown;
  route?: string | { readonly path: string; readonly name?: string };
  middleware?: readonly PipelineMiddleware[];
  validation?: { schema?: BaseValidator; validating?: readonly string[] };
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
};

export type PageRouteMatch = {
  entry: PageRouteEntry;
  params: Record<string, string>;
  query: Record<string, string>;
};

export type ExecutePageRequestOptions<TResult = PageDataBundle> = {
  url: string;
  routes: readonly PageRouteEntry[];
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
    }
  | { stage: "validation"; status: number; errors: unknown };

export type PageErrorRecord = {
  /** Never serialized; preserves the actual thrown value for server error.page.tsx. */
  originalError: unknown;
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
    query: Record<string, string>;
  };
  appData?: unknown;
  layoutData?: unknown;
  pageData?: unknown;
  shared?: Readonly<SharedContext>;
  metadata?: MetadataOutput;
  shortCircuit?: PageShortCircuit;
  error?: PageErrorRecord;
  /**
   * Selected only for the framework-owned application error-page terminal —
   * already the JSON-safe shape (`hydrationErrorPageProps` produces this, not
   * the raw `ErrorPageProps` an authored `error.page.tsx` renders from during
   * SSR), because this field's only consumer is the hydration payload
   * (`build-hydration-payload.ts`), never a component prop.
   */
  errorPage?: SerializedErrorPageProps;
};
