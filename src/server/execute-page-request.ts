import { v } from "@warlock.js/seal";
import type { MetadataOutput } from "../metadata";
import { enterSharedScope, sealShared, shared, type SharedStore } from "../shared";
import type { SharedContext } from "../index";
import {
  createBufferedResponse,
  isLoaderShortCircuit,
  type BufferedCookie,
  type BufferedHeader,
  type ResponseBuffer,
} from "./buffered-response";

/**
 * Pipeline stages 1–8 of a page request (canon 20c425dd §3,
 * design/request-lifecycle.md:27-63). Stages 9–10 (render/emit) are the next
 * slice; this one ends at the DATA BUNDLE.
 *
 * The founding sentence governs the shape: a page route is an ordinary
 * Warlock route whose handler renders React instead of returning JSON. So
 * every stage here mirrors what core already does for an API request:
 *
 *  - the ALS frame is opened over core's own store shape
 *    (`{ request, response }`, core/src/http/context/request-context.ts:10-13)
 *    with core's own `run` — see `connectPageContext` below;
 *  - middleware short-circuits on `output !== undefined`, core's exact rule
 *    (core/src/http/request.ts:769);
 *  - validation mirrors `validateAll` (core/src/validation/validateAll.ts:36-60):
 *    `v.validate(schema, data)`, success calls `request.setValidatedData`,
 *    failure is a 422 (core/src/http/response.ts:1399-1404) — recorded here as
 *    a designation in the bundle, since sending is the emit slice's job.
 */

// ---------------------------------------------------------------------------
// The context seam (A.3's pattern, one step further)
// ---------------------------------------------------------------------------

/**
 * The pipeline's per-request store — at runtime this IS core's
 * `RequestContextStore` (`{ request, response }`, request-context.ts:10-13).
 * Extends `SharedStore` so the same object feeds `enterSharedScope`/`sealShared`.
 */
export type PipelineStore = SharedStore & {
  request: unknown;
  response: unknown;
};

/**
 * What `connectPageContext` accepts. Core's `requestContext` satisfies this
 * as-is: `run` is the inherited `Context.run` (context/src/base-context.ts:83-85,
 * a straight delegate to `AsyncLocalStorage.run`), `getStore` likewise, and
 * `buildStore` is `RequestContext.buildStore` (request-context.ts:56-61) — the
 * very function core's http path feeds through `contextManager.buildStores`
 * (inject-request-context.ts:61).
 */
export type PageContextRunner = {
  run<T>(store: PipelineStore, callback: () => T): T;
  getStore(): PipelineStore | undefined;
  buildStore?(payload?: Record<string, any>): PipelineStore;
};

let pageContextRunner: PageContextRunner | undefined;

/**
 * Boot-time wiring, once per process, owned by the server bootstrap (the
 * wiring slice) — web cannot import core (A.3 §2: no core dep, no built esm),
 * so the code that HAS `requestContext` in scope hands it over:
 *
 *   connectPageContext(requestContext);
 *   connectSharedStore(() => requestContext.getStore());
 *
 * Returns the previous runner so tests can restore it.
 */
export function connectPageContext(
  runner: PageContextRunner | undefined,
): PageContextRunner | undefined {
  const previous = pageContextRunner;
  pageContextRunner = runner;
  return previous;
}

function requireRunner(): PageContextRunner {
  if (!pageContextRunner) {
    throw new Error(
      "executePageRequest() has no request context connected " +
        "(web/src/server/execute-page-request.ts). The pipeline opens the " +
        "per-request AsyncLocalStorage frame with CORE's own context — it " +
        "never owns one itself. Fix: the server bootstrap must call " +
        "connectPageContext(requestContext) (and " +
        "connectSharedStore(() => requestContext.getStore())) before any " +
        "page request runs.",
    );
  }

  return pageContextRunner;
}

// ---------------------------------------------------------------------------
// Route map + page module contracts (fixture-shaped; the manifest generator
// replaces the hand-authored map in a later slice)
// ---------------------------------------------------------------------------

export type PageLevelName = "app" | "layout" | "page";

/** v5 middleware: ONE ctx object, pass-through is `undefined` (request.ts:769). */
export type PipelineMiddleware = (ctx: {
  request: any;
  response: any;
}) => unknown | Promise<unknown>;

export type PipelineLoader = (ctx: {
  request: any;
  response: any;
  shared: SharedContext;
}) => unknown | Promise<unknown>;

/** The server half of a page/layout/App module (canon 20c425dd §4). */
export type PageTripleModule = {
  route?: string | { readonly path: string; readonly name?: string };
  middleware?: readonly PipelineMiddleware[];
  validation?: { schema?: unknown; validating?: readonly string[] };
  loader?: PipelineLoader;
  metadata?: unknown;
  /** Runs-twice half — carried through untouched; the render slice consumes them. */
  default?: unknown;
  ErrorBoundary?: unknown;
};

/**
 * One manifest entry, hand-authored for this slice
 * (design/request-lifecycle.md:20 — the real manifest generator emits the
 * same shape per page: absolute URL, route name, the App/Layout/Page triple).
 */
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

export type ExecutePageRequestOptions = {
  /** Path + optional query string, e.g. `/products/42?tab=specs`. */
  url: string;
  routes: readonly PageRouteEntry[];
  /**
   * The caller's mirror of core's `handleRoute` body (router.ts:924-932):
   * construct the Request/Response pair for this match. In production this is
   * core's route handler; in tests it builds REAL core instances.
   */
  createHttp(match: PageRouteMatch): { request: any; response: any };
};

// ---------------------------------------------------------------------------
// The data bundle (stages 1–8 output; render/emit consume it next slice)
// ---------------------------------------------------------------------------

export type PageBoundaryDesignation = {
  /** The level whose loader rejected. */
  throwingLevel: PageLevelName;
  /**
   * The level whose `ErrorBoundary` export would render: nearest boundary at
   * or rootward of the throw ("nearest boundary wins",
   * v5/app/src/app/products/web/product-details.page.tsx:96-99); `app` is the
   * terminal fallback — the framework owns a root boundary.
   */
  boundaryLevel: PageLevelName;
};

export type PageResponseCommit = {
  /** Final per-key state, root→leaf: a leafward write wins its key. */
  headers: BufferedHeader[];
  /** Final per-name state, root→leaf. */
  cookies: BufferedCookie[];
  statusCode?: number;
  /** Which levels' buffers survived the settle rules, root→leaf order. */
  committedLevels: PageLevelName[];
};

export type PageShortCircuit =
  | { stage: "middleware"; level: PageLevelName; value: unknown }
  | { stage: "validation"; status: number; errors: unknown }
  | {
      stage: "loaders";
      level: PageLevelName;
      kind: "redirect" | "notFound";
      statusCode: number;
      url?: string;
      body?: unknown;
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
  /** `sealShared()`'s RETURN — the sealed target, never a proxy re-read (A.3 §7). */
  shared?: Readonly<SharedContext>;
  metadata?: MetadataOutput;
  commit?: PageResponseCommit;
  shortCircuit?: PageShortCircuit;
  error?: { error: unknown; boundary: PageBoundaryDesignation };
};

// ---------------------------------------------------------------------------
// Stage 1 — MATCH
// ---------------------------------------------------------------------------

function splitSegments(path: string): string[] {
  return path.split("/").filter(segment => segment.length > 0);
}

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(pathname);

  if (patternSegments.length !== pathSegments.length) return undefined;

  const params: Record<string, string> = {};

  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];

    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (patternSegment !== pathSegment) return undefined;
  }

  return params;
}

function matchRoute(
  pathname: string,
  routes: readonly PageRouteEntry[],
): { entry: PageRouteEntry; params: Record<string, string> } | undefined {
  for (const entry of routes) {
    const params = matchPath(entry.path, pathname);

    if (params) return { entry, params };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Stage 4 — validation input (mirror of validateAll.ts:8-31, with the PAGE
// default from design/request-lifecycle.md:41-42: params + query, not body)
// ---------------------------------------------------------------------------

function resolveValidationData(
  validating: readonly string[] | undefined,
  request: any,
  match: { params: Record<string, string>; query: Record<string, string> },
): Record<string, unknown> {
  if (!validating || validating.length === 0) {
    return { ...match.query, ...match.params };
  }

  let data: Record<string, unknown> = {};

  for (const source of validating) {
    if (source === "body") data = { ...data, ...(request.body ?? {}) };
    if (source === "query") data = { ...data, ...match.query };
    if (source === "params") data = { ...data, ...match.params };
    if (source === "headers") data = { ...data, ...(request.headers ?? {}) };
  }

  return data;
}

// ---------------------------------------------------------------------------
// Stage 7 — settle/commit helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: readonly PageLevelName[] = ["app", "layout", "page"];

/**
 * Apply the surviving buffers to the REAL response, root→leaf, per cookie
 * name / header key (canon 20c425dd §10): a leafward level re-writing the same
 * key wins it, everything else merges. Application happens once, here — the
 * loaders only ever touched their buffers.
 */
function commitBuffers(
  realResponse: any,
  ordered: readonly { level: PageLevelName; buffer: ResponseBuffer }[],
  forcedStatusCode?: number,
): PageResponseCommit {
  const headers = new Map<string, BufferedHeader>();
  const cookies = new Map<string, BufferedCookie>();
  let statusCode: number | undefined;

  for (const { buffer } of ordered) {
    for (const header of buffer.headers) headers.set(header.key.toLowerCase(), header);
    for (const cookie of buffer.cookies) cookies.set(cookie.name, cookie);
    if (buffer.statusCode !== undefined) statusCode = buffer.statusCode;
  }

  if (forcedStatusCode !== undefined) statusCode = forcedStatusCode;

  for (const header of headers.values()) realResponse.header(header.key, header.value);
  for (const cookie of cookies.values()) realResponse.cookie(cookie.name, cookie.value, cookie.options);
  if (statusCode !== undefined) realResponse.setStatusCode(statusCode);

  return {
    headers: [...headers.values()],
    cookies: [...cookies.values()],
    statusCode,
    committedLevels: ordered.map(({ level }) => level),
  };
}

function designateBoundary(
  throwingLevel: PageLevelName,
  triple: PageRouteEntry["triple"],
): PageBoundaryDesignation {
  const throwingIndex = LEVEL_ORDER.indexOf(throwingLevel);

  for (let index = throwingIndex; index >= 0; index--) {
    const level = LEVEL_ORDER[index];

    if (triple[level].ErrorBoundary) {
      return { throwingLevel, boundaryLevel: level };
    }
  }

  // The framework owns a root boundary; `app` is the terminal designation.
  return { throwingLevel, boundaryLevel: "app" };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function executePageRequest(
  options: ExecutePageRequestOptions,
): Promise<PageDataBundle | undefined> {
  const runner = requireRunner();

  // ── stage 1 · MATCH ─────────────────────────────────────────────────────
  // One route table. In production fastify has already matched when core's
  // handleRoute runs (router.ts:923-924); over the hand-authored fixture map
  // the pipeline does the equivalent lookup itself.
  const [pathname, queryString] = options.url.split("?");
  const matched = matchRoute(pathname, options.routes);

  if (!matched) return undefined;

  const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
  const match: PageRouteMatch = { entry: matched.entry, params: matched.params, query };
  const { triple } = matched.entry;

  // The caller mirrors handleRoute's construction (router.ts:924-932).
  const { request, response } = options.createHttp(match);

  // ── stage 2 · CONTEXT ───────────────────────────────────────────────────
  // Core's own store shape ({ request, response }, request-context.ts:10-13),
  // built by core's own buildStore when the runner carries one
  // (request-context.ts:56-61), entered with core's own run
  // (base-context.ts:83-85). `enterSharedScope` keys the shared target by
  // this exact store object (A.3 §7).
  const store: PipelineStore = runner.buildStore
    ? runner.buildStore({ request, response })
    : { request, response };

  return await runner.run(store, async () => {
    enterSharedScope(store);

    const bundle: PageDataBundle = {
      route: {
        name: matched.entry.name,
        path: matched.entry.path,
        params: match.params,
        query,
      },
    };

    // ── stage 3 · MIDDLEWARE ──────────────────────────────────────────────
    // Sequential, outermost first: App → Layout → Page. Middleware gets the
    // REAL request/response (it runs alone, before any parallelism) and is
    // the only writer of `shared`. Short-circuit is core's exact rule:
    // output !== undefined stops everything below (request.ts:769).
    for (const level of LEVEL_ORDER) {
      for (const middleware of triple[level].middleware ?? []) {
        const output = await middleware({ request, response });

        if (output !== undefined) {
          bundle.shortCircuit = { stage: "middleware", level, value: output };
          return bundle;
        }
      }
    }

    // ── stage 4 · VALIDATION ──────────────────────────────────────────────
    // The page's { schema, validating } over params + query
    // (request-lifecycle.md:41-42), run exactly the way core runs it
    // (validateAll.ts:49-60). Failure stops before the seal: 422 designation
    // in the bundle, sending is the emit slice's job.
    const validation = triple.page.validation;

    if (validation?.schema) {
      const data = resolveValidationData(validation.validating, request, match);
      const result = await v.validate(validation.schema as any, data);

      if (result.isValid && result.data) {
        request.setValidatedData?.(result.data);
      }

      if (!result.isValid) {
        bundle.shortCircuit = { stage: "validation", status: 422, errors: result.errors };
        return bundle;
      }
    }

    // ── stage 5 · SEAL shared ─────────────────────────────────────────────
    // gate → parse → dev-freeze, all inside sealShared (A.3). From here
    // `shared` is immutable and identical for every reader; the bundle
    // carries sealShared's RETURN, never a proxy re-read.
    const sealedShared = await sealShared(store);

    bundle.shared = sealedShared;

    // ── stage 6 · LOADERS ─────────────────────────────────────────────────
    // PARALLEL. Each loader gets the ctx object with ITS OWN buffered
    // response; loaders never read each other and never write `shared`
    // (it is sealed — a write throws by A.3's contract).
    const buffers = LEVEL_ORDER.map(level => {
      const { response: bufferedResponse, buffer } = createBufferedResponse();

      return { level, buffer, bufferedResponse };
    });

    const settled = await Promise.allSettled(
      buffers.map(({ level, bufferedResponse }) => {
        const loader = triple[level].loader;

        return (async () =>
          loader ? await loader({ request, response: bufferedResponse, shared }) : undefined)();
      }),
    );

    // ── stage 7 · SETTLE / COMMIT ─────────────────────────────────────────
    // allSettled above; now walk root→leaf for the first abnormal outcome.
    // Throw: the throwing layer's buffer is discarded with its siblings'
    // below it, the nearest boundary renders, the framework owns the status
    // (request-lifecycle.md:51-54). Short-circuit (redirect/notFound): the
    // signalling layer's own buffer commits, siblings below are discarded.
    let firstError: { level: PageLevelName; index: number; error: unknown } | undefined;
    let firstSignal:
      | { level: PageLevelName; index: number; signal: ReturnType<typeof toSignal> }
      | undefined;

    function toSignal(value: unknown) {
      return isLoaderShortCircuit(value) ? value : undefined;
    }

    for (let index = 0; index < LEVEL_ORDER.length; index++) {
      const result = settled[index];

      if (result.status === "rejected") {
        firstError = { level: LEVEL_ORDER[index], index, error: result.reason };
        break;
      }

      const signal = toSignal(result.value);

      if (signal) {
        firstSignal = { level: LEVEL_ORDER[index], index, signal };
        break;
      }
    }

    const dataKeys: Record<PageLevelName, "appData" | "layoutData" | "pageData"> = {
      app: "appData",
      layout: "layoutData",
      page: "pageData",
    };

    // Fulfilled sibling data stays in the bundle — a throw elsewhere never
    // costs a healthy layer its data. Levels leafward of a short-circuit are
    // discarded with their buffers (they will not render).
    const dataCutoff = firstSignal ? firstSignal.index : LEVEL_ORDER.length;

    for (let index = 0; index < LEVEL_ORDER.length; index++) {
      const result = settled[index];

      if (result.status !== "fulfilled") continue;
      if (firstError && index === firstError.index) continue;
      if (index > dataCutoff) continue;
      if (toSignal(result.value)) continue;

      bundle[dataKeys[LEVEL_ORDER[index]]] = result.value;
    }

    if (firstError) {
      // Commit strictly rootward of the throw; the framework owns the status
      // when a boundary renders (canon 20c425dd §10).
      bundle.error = {
        error: firstError.error,
        boundary: designateBoundary(firstError.level, triple),
      };
      bundle.commit = commitBuffers(response, buffers.slice(0, firstError.index), 500);
    } else if (firstSignal) {
      bundle.shortCircuit = {
        stage: "loaders",
        level: firstSignal.level,
        kind: firstSignal.signal!.kind,
        statusCode: firstSignal.signal!.statusCode,
        url: firstSignal.signal!.url,
        body: firstSignal.signal!.body,
      };
      bundle.commit = commitBuffers(response, buffers.slice(0, firstSignal.index + 1));
    } else {
      bundle.commit = commitBuffers(response, buffers);
    }

    // ── stage 8 · METADATA ────────────────────────────────────────────────
    // metadata({ data, error, shared }) — exactly one of data/error set
    // (request-lifecycle.md:56). Skipped after a loader short-circuit: a
    // redirect/notFound answer has no page render to describe. The M1
    // `PageMetadata` type declares { data, shared }; `error` joins the
    // declared type with the render slice — the runtime contract is ahead of
    // the declaration here, recorded in the P1 report.
    if (!bundle.shortCircuit) {
      const metadata = triple.page.metadata;

      if (typeof metadata === "function") {
        bundle.metadata = await metadata({
          data: bundle.error ? undefined : bundle.pageData,
          error: bundle.error ? bundle.error.error : undefined,
          shared: sealedShared,
        });
      } else if (metadata) {
        bundle.metadata = metadata as MetadataOutput;
      }
    }

    return bundle;
  });
}
