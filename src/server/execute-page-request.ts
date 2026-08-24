import { v, type BaseValidator } from "@warlock.js/seal";
import { randomUUID } from "node:crypto";
import type { WebRequest } from "../context";
import type { MetadataOutput, PageMetadata } from "../metadata";
import { resolvePageMetadata } from "./resolve-page-metadata";
import { resolveValidationData } from "./resolve-validation-data";
import { enterSharedScope, sealShared, shared, type SharedStore } from "../shared";
import type { SharedContext } from "../index";
import {
  createBufferedResponse,
  isLoaderShortCircuit,
  type BufferedCookie,
  type BufferedHeader,
  type BufferedWebResponse,
  type LoaderShortCircuitSignal,
  type ResponseBuffer,
} from "./buffered-response";

/**
 * Pipeline stages 1–8 of a page request. Stages 9–10 (render/emit) are the
 * next slice; this one ends at the DATA BUNDLE.
 *
 * The founding sentence governs the shape: a page route is an ordinary
 * Warlock route whose handler renders React instead of returning JSON. So
 * every stage here mirrors what core already does for an API request:
 *
 *  - the ALS frame is opened over core's own store shape
 *    (`{ request, response }`, core/src/http/context/request-context.ts:10-13)
 *    with core's own `run` — see `connectPageContext` below;
 *  - middleware short-circuits on `output !== undefined`, core's exact rule
 *    (`Request.executeMiddleware`, core/src/http/request.ts:817);
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
  run<T>(store: PipelineStore, callback: () => Promise<T>): Promise<T>;
  getStore(): PipelineStore | undefined;
  buildStore?(payload?: Record<string, any>): PipelineStore;
};

let pageContextRunner: PageContextRunner | undefined;
let additionalSharedScopeEntry: ((store: PipelineStore) => void) | undefined;

/**
 * Boot-time wiring, once per process, owned by the server bootstrap (the
 * wiring slice) — a value import of core from web risks resolving a second
 * core instance, and two copies of core means two AsyncLocalStorage stores
 * (core is a type-only peer of web, never a value import). So the code that HAS
 * `requestContext` in scope hands it over:
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

/**
 * Connects an additional shared-module instance that must enter every request.
 * Normal production has one module graph and needs no additional entry; the
 * dev server uses this seam for the Vite SSR graph that evaluates app code.
 */
export function connectPageSharedScope(
  enter: ((store: PipelineStore) => void) | undefined,
): ((store: PipelineStore) => void) | undefined {
  const previous = additionalSharedScopeEntry;
  additionalSharedScopeEntry = enter;
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

/**
 * The real request this pipeline touches directly (stages 3-4): `WebRequest`
 * (context.ts:30-63) is the loader-facing MINIMAL facade and doesn't declare
 * the raw validation sources or `setValidatedData` — core's actual `Request`
 * has all of these (`Request.body`, request.ts:914; `Request.headers`,
 * request.ts:1239; `Request.setValidatedData`, request.ts:769). A type-only
 * core import is permitted but deliberately not used:
 * the seam declares exactly the members the pipeline touches, keeping the
 * coupling explicit. Composed via `&`, not `extends`,
 * mirroring `BufferedWebResponse`'s own precedent below.
 */
export type PipelineRequest = WebRequest & {
  body?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  /**
   * Core's own parses (`core/src/http/request.ts:1010,1026`), and the ONLY
   * query/params the pipeline reads. Stage 4 used to take these two from a
   * match object this file built by re-parsing the URL — see
   * `resolve-validation-data.ts` for what that cost.
   */
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  setValidatedData?(data: Record<string, unknown>): void;
};

/**
 * The real response the pipeline touches: exactly the four members it calls —
 * `header`/`cookie`/`setStatusCode` at the stage-7 commit and `parse` inside
 * `sealShared` (`sealShared`, shared.ts seal path). Standalone rather than a
 * `WebResponse` base: that facade's `redirect`/`notFound` return the BRANDED
 * short-circuit signal (context.ts:81-87), which core's real `Response` never
 * carries (`Response.redirect`, response.ts:862-865) — basing this type on it
 * would reject the very instances the seam exists to admit.
 */
export type PipelineResponse = {
  header(key: string, value: string): PipelineResponse;
  cookie(name: string, value: unknown, options?: Record<string, unknown>): PipelineResponse;
  setStatusCode(statusCode: number): PipelineResponse;
  parse(value: unknown): Promise<unknown>;
};

/** v5 middleware: ONE ctx object, pass-through is `undefined` (`Request.executeMiddleware`, request.ts:817). */
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
  /**
   * Typed against `PipelineLoader` itself (not a per-page loader type this
   * fixture-shaped manifest has no way to carry): `LoaderData<PipelineLoader>`
   * resolves to `unknown` (props.ts:14-16), matching `bundle.pageData`'s own
   * type below — the function-context call at stage 8 typechecks with no cast.
   */
  metadata?: PageMetadata<PipelineLoader>;
  /** Runs-twice half — carried through untouched; the render slice consumes them. */
  default?: unknown;
  ErrorBoundary?: unknown;
};

/**
 * One manifest entry, hand-authored for this slice. The real manifest
 * generator emits the same shape per page: absolute URL, route name, the
 * App/Layout/Page triple.
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

export type ExecutePageRequestOptions<TResult = PageDataBundle> = {
  /** Path + optional query string, e.g. `/products/42?tab=specs`. */
  url: string;
  routes: readonly PageRouteEntry[];
  /**
   * The caller's mirror of core's `handleRoute` body (router.ts:924-932):
   * construct the Request/Response pair for this match. In production this is
   * core's route handler; in tests it builds REAL core instances.
   */
  createHttp(match: PageRouteMatch): { request: PipelineRequest; response: PipelineResponse };
  /**
   * Continue stages 9-10 before the request context closes. This is the
   * render seam: it receives the completed bundle inside the exact ALS store
   * and shared scope used by middleware and loaders.
   */
  finish?(bundle: PageDataBundle): TResult | Promise<TResult>;
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
  | {
      stage: "middleware";
      level: PageLevelName;
      value: unknown;
      /** D1: the live response's status at the moment of short-circuit, captured
       * where the pipeline legitimately touches it (stage 3) — `finishRender`
       * no longer needs `captured?.response.statusCode`. */
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
 * What a throw becomes once it enters the bundle (`buildErrorRecord` below,
 * the one place this happens). `digest` is an opaque id generated there;
 * `scrubbed` says whether `error` is the raw thrown value or a production
 * surrogate standing in for it.
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
     * ⚠ Re-parsed from the URL by this file's own matcher, NOT core's parse —
     * so it is flat and last-wins: `?tags=a&tags=b&filter[status]=active`
     * arrives as `{ tags: "b", "filter[status]": "active" }`.
     *
     * Nothing in `web` reads it any more — stage 4 was the last consumer and
     * now takes its query from the request (`resolve-validation-data.ts`).
     * It survives only because it is part of this public bundle type, and it
     * goes away with the second matcher itself. **Read `request.query`.**
     */
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
  error?: PageErrorRecord;
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
// Stage 7 — settle/commit helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: readonly PageLevelName[] = ["app", "layout", "page"];

/**
 * Settle the surviving buffers root→leaf, per cookie name / header key: a
 * leafward level re-writing the same key wins it, everything else merges. The
 * loaders only ever touched their buffers; this is where the winners are
 * decided.
 *
 * WHAT THIS WRITES TO THE LIVE RESPONSE, AND WHAT IT DELIBERATELY DOES NOT.
 * Headers and status are mirrored onto `realResponse` here; COOKIES ARE NOT.
 * That asymmetry is the fix for a real defect, and it is not arbitrary:
 *
 *   - `header()` and `setStatusCode()` are SET operations, keyed. Writing the
 *     same key twice leaves one value on the wire, so the mirror and the
 *     emit's own `response.headers(rendered.headers)` are idempotent with
 *     each other.
 *   - `cookie()` APPENDS. Fastify's `setCookie` emits one `Set-Cookie` header
 *     per call, so mirroring here and replaying at the emit put the SAME
 *     cookie on the wire twice — on every page response, happy path included
 *     (`page-redirect-wire.spec.ts`, which asserted the duplicate on purpose
 *     until this change removed it).
 *
 * The emit is the authoritative application site, so the cookie loop is the
 * one that goes. `finishRender` adds the framework's own headers after this
 * function has run and chooses the final status only once the render can no
 * longer change it, so the emit has to apply the returned maps regardless —
 * it is a superset of this mirror, and it is the ONLY consumer
 * (`createPageRouteHandler`, the single production emit path, replays
 * `rendered.cookies` through `applyBufferedCookie`). A stage-7 cookie write
 * is also committed before stage 9 can overturn the answer, which is already
 * a known wart of the status mirror above.
 *
 * The header mirror is left alone deliberately: it is idempotent, it carries
 * the `Location` a loader redirect writes into its buffer
 * (`buffered-response.ts`), and that path landed proven — this card
 * de-duplicates `Set-Cookie` and changes no redirect behaviour.
 */
function commitBuffers(
  realResponse: PipelineResponse,
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
  if (statusCode !== undefined) realResponse.setStatusCode(statusCode);

  // No `realResponse.cookie(...)` loop here — see the note above. The settled
  // cookies leave through the return value only, and the emit applies them
  // exactly once.

  return {
    headers: [...headers.values()],
    cookies: [...cookies.values()],
    statusCode,
    committedLevels: ordered.map(({ level }) => level),
  };
}

export function designateBoundary(
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

/**
 * The one place a throw enters the bundle (middleware, stage 3; loaders,
 * stage 7) — generates `digest` and decides scrubbing. Production never lets
 * the raw error reach a client: the boundary receives a surrogate carrying
 * only `digest`, which is exactly what the reference App's ErrorBoundary
 * renders (v5/app/src/web/root.tsx:136-158 — `error.digest`, nothing else).
 * Dev keeps the raw thrown value so the boundary/console see the real
 * stack; it is never mutated to attach `digest` — `digest` lives on the
 * RECORD only.
 */
export function buildErrorRecord(
  thrown: unknown,
  boundary: PageBoundaryDesignation,
  requestPath?: string,
): PageErrorRecord {
  const digest = randomUUID();

  // The boundary says the problem was logged, so log it; a digest absent from every log is worse than none.
  console.error("[warlock] page error", digest, ...(requestPath ? [requestPath] : []), thrown);

  if (process.env.NODE_ENV === "production") {
    const surrogate = new Error("An unexpected error occurred.");

    (surrogate as Error & { digest: string }).digest = digest;

    return { error: surrogate, boundary, digest, scrubbed: true };
  }

  return { error: thrown, boundary, digest, scrubbed: false };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function executePageRequest<TResult = PageDataBundle>(
  options: ExecutePageRequestOptions<TResult>,
): Promise<TResult | undefined> {
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
    additionalSharedScopeEntry?.(store);

    const finish = async (bundle: PageDataBundle): Promise<TResult> =>
      options.finish ? await options.finish(bundle) : (bundle as TResult);

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
    // output !== undefined stops everything below (`Request.executeMiddleware`,
    // request.ts:817).
    for (const level of LEVEL_ORDER) {
      for (const middleware of triple[level].middleware ?? []) {
        let output: unknown;

        try {
          output = await middleware({ request, response });
        } catch (thrown) {
          // A middleware throw means NOTHING was served: no loaders ran, no
          // buffers exist. The "a nested boundary keeps the committed status"
          // rule is predicated on the page being substantially served, so it
          // cannot apply here — the framework forces 500 regardless of which
          // level the boundary designates to.
          const boundary = designateBoundary(level, triple);

          bundle.error = buildErrorRecord(thrown, boundary, pathname);
          bundle.commit = commitBuffers(response, [], 500);

          return finish(bundle);
        }

        if (output !== undefined) {
          bundle.shortCircuit = {
            stage: "middleware",
            level,
            value: output,
            // D1: capture the live status HERE, where the pipeline
            // legitimately touches the response — `finishRender` becomes a
            // pure function of (triple, bundle).
            statusCode: (response as PipelineResponse & { statusCode?: number }).statusCode,
          };
          return finish(bundle);
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
      const data = resolveValidationData(validation.validating, request);
      const result = await v.validate(validation.schema, data);

      if (result.isValid && result.data) {
        request.setValidatedData?.(result.data);
      }

      if (!result.isValid) {
        bundle.shortCircuit = { stage: "validation", status: 422, errors: result.errors };
        return finish(bundle);
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
      | { level: PageLevelName; index: number; signal: LoaderShortCircuitSignal }
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
      const boundary = designateBoundary(firstError.level, triple);

      bundle.error = buildErrorRecord(firstError.error, boundary, pathname);

      // Commit strictly rootward of the throw. A NESTED boundary catch keeps the committed status (the page was
      // substantially served); only the ROOT (`app`) boundary forces 5xx.
      bundle.commit = commitBuffers(
        response,
        buffers.slice(0, firstError.index),
        boundary.boundaryLevel === "app" ? 500 : undefined,
      );
    } else if (firstSignal) {
      bundle.shortCircuit = {
        stage: "loaders",
        level: firstSignal.level,
        kind: firstSignal.signal.kind,
        statusCode: firstSignal.signal.statusCode,
        url: firstSignal.signal.url,
        body: firstSignal.signal.body,
      };
      bundle.commit = commitBuffers(response, buffers.slice(0, firstSignal.index + 1));
    } else {
      bundle.commit = commitBuffers(response, buffers);
    }

    // ── stage 8 · METADATA ────────────────────────────────────────────────
    // metadata({ data, shared }), success path only — `resolve-page-metadata.ts`
    // owns the rule and the reasoning. Skipped entirely after a loader
    // short-circuit: a redirect/notFound answer has no page render to describe.
    if (!bundle.shortCircuit) {
      const resolved = resolvePageMetadata({
        metadata: triple.page.metadata,
        data: bundle.pageData,
        error: bundle.error?.error,
        failed: Boolean(bundle.error),
        shared: sealedShared,
      });

      bundle.metadata = resolved.metadata;

      /*
        The page's own metadata function threw, and there was no earlier error
        for it to mask. Record it exactly as a loader throw is recorded, so the
        boundary renders and the framework keeps the status — rather than
        letting the exception escape stage 8, where nothing is left to catch it
        and the committed buffers from stage 7 would already be on the wire.
      */
      if (resolved.thrown !== undefined) {
        bundle.error = buildErrorRecord(
          resolved.thrown,
          designateBoundary("page", triple),
          bundle.route.path,
        );
      }
    }

    return finish(bundle);
  });
}
