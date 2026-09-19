import {
  buildTracingContext,
  dispatchPhase,
  environment,
  isTracingEnabled,
  Response,
  type Request,
} from "@warlock.js/core";
import { getSealConfig, v } from "@warlock.js/seal";
import { enterSharedScope, sealShared } from "../shared";
import { connectRequestSearch } from "../routing/query-string";
import { enterAdditionalSharedScope, requireRunner } from "./page-context";
import { createRequestAbortController } from "./request-abort-signal";
import { matchRoute } from "./match-page-route";
import { resolvePageMetadata } from "./resolve-page-metadata";
import { resolveValidationData } from "./resolve-validation-data";
import { resolvePageValidationInput } from "./resolve-route-validation-input";
import { PageValidationFailedError } from "./page-validation-failed-error";
import { DeferredInNonPageLoaderError, isDeferred, splitDeferredPageData } from "../loaders/defer";
import { createDeferredSettlement, type DeferSettlement } from "./defer-settlement";
import { resolveDeferTimeoutMs, resolveLoaderTimeoutMs } from "./streaming-config";
import { PageLoaderTimeoutError } from "./page-loader-timeout-error";
import {
  buildErrorRecord,
  commitBuffers,
  createBufferedResponse,
  createLevelBuffer,
  designateBoundary,
  isLoaderShortCircuit,
  LEVEL_ORDER,
  type LevelBuffer,
  type PageResponseCommit,
} from "./settle-page-response";
import type {
  ExecutePageRequestOptions,
  PageDataBundle,
  PageLevelName,
  PageRouteMatch,
  PageTripleModule,
  PipelineStore,
} from "./execute-page-request.types";

export * from "./execute-page-request.types";
export { connectPageContext } from "./page-context";
export {
  buildErrorRecord,
  designateBoundary,
  type BufferedCookie,
  type BufferedHeader,
  type LoaderShortCircuitKind,
  type PageResponseCommit,
} from "./settle-page-response";
export { RouteMiddlewareRemovedError } from "./install-page-routes";

/**
 * `route.middleware` shipped in 5.6.0 and was withdrawn (owner ruling,
 * 2026-09-08): a page declares middleware in exactly one place, the
 * top-level `middleware` export. Thrown the first time a matched route's
 * page module still carries a `middleware` key on `route` — loud, not a
 * silent no-op, so the guard the author thinks is running is never quietly
 * dropped.
 */
/* RouteMiddlewareRemovedError moved to install-page-routes.ts, where pageFile is available.
export class RouteMiddlewareRemovedError extends Error {
  public constructor(
    public readonly routeName: string,
    public readonly routePath: string,
  ) {
    super(
      `Warlock route "${routeName}" (${routePath}) declares \`route.middleware\`, which no ` +
        "longer runs — it was withdrawn after 5.6.0. Move it to the page's own top-level " +
        "`middleware` export instead: `export const middleware = [...]`.",
    );
    this.name = "RouteMiddlewareRemovedError";
  }
}
*/

/** Widens `PageDataBundle` with the two fields stage 6/7 populate. */
type Bundle = PageDataBundle & {
  commit?: PageResponseCommit;
  shortCircuit?: PageDataBundle["shortCircuit"] & {
    kind?: "redirect" | "notFound";
    url?: string;
    body?: unknown;
  };
};

/**
 * Self-wires `useQueryString`'s SSR seam to the SAME per-request store
 * `connectSharedStore`/`connectPageContext` already read (canon `1ca1e8ae`'s
 * scoping) — done HERE, once, rather than asking every server bootstrap
 * (dev's Vite-graph wiring in `web-connector.ts`, prod's
 * `installProductionPageRoutes`) to remember a THIRD `connect*` call for the
 * same store.
 *
 * The resolver calls `requireRunner()` on every read, not the `runner`
 * closed over by its caller: `runner.getStore()` is only valid for as long as
 * that particular runner is connected, and a test (or a later reconnect)
 * that swaps in a new one via `connectPageContext` must not leave this
 * resolver reading a stale runner's store.
 */
let requestSearchWired = false;

function wireRequestSearch(): void {
  if (requestSearchWired) return;

  requestSearchWired = true;
  connectRequestSearch(() => requireRunner().getStore()?.request.url);
}

type PageValidationOutcome = { valid: true } | { valid: false; errors: unknown };

/**
 * What the `:value` placeholder renders in a production issue message.
 *
 * Issue messages reach the SSR document and the hydration payload verbatim, so
 * `:value` in a translation or an author `errorMessage` must not interpolate
 * the raw input there. A custom rule that concatenates raw input into its own
 * message text is not covered. Development keeps the value for diagnostics.
 */
const REDACTED_VALUE = "…";

/**
 * Runs the page's top-level `validation` export against the request, and on
 * success stores the validated output where `request.validated()` reads it.
 *
 * The `{ params, query }` shape builds one outer envelope from the DECLARED
 * keys only and is fed exactly those sources (`resolvePageValidationInput`,
 * card 7d891485); the legacy `{ schema, validating }` shape keeps its own
 * input resolver. A validation export with nothing to validate passes.
 */
async function validatePageInput(
  validation: NonNullable<PageTripleModule["validation"]>,
  request: Request,
): Promise<PageValidationOutcome> {
  const legacyValidation = "schema" in validation || "validating" in validation;
  const declaresParams = !legacyValidation && validation.params !== undefined;
  const declaresQuery = !legacyValidation && validation.query !== undefined;
  const schema = legacyValidation
    ? validation.schema
    : v.object({
        ...(declaresParams ? { params: validation.params } : {}),
        ...(declaresQuery ? { query: validation.query } : {}),
      });

  if (!schema) return { valid: true };

  const data = legacyValidation
    ? resolveValidationData(validation.validating, request)
    : resolvePageValidationInput(request, { params: declaresParams, query: declaresQuery });
  // Per-call options replace Seal's global config rather than merging with it,
  // so the app's translators are passed through alongside the redaction.
  const result = await v.validate(
    schema,
    data,
    environment() === "production"
      ? { ...getSealConfig(), redactValue: REDACTED_VALUE }
      : undefined,
  );

  if (!result.isValid) return { valid: false, errors: result.errors };

  if (result.data) request.setValidatedData(result.data);

  return { valid: true };
}

export async function executePageRequest<TResult = PageDataBundle>(
  options: ExecutePageRequestOptions<TResult>,
): Promise<TResult | Response | undefined> {
  const runner = requireRunner();

  wireRequestSearch();
  const [pathname = "", queryString] = options.url.split("?");
  // HTTP page handlers arrive here after core's router selected their route.
  // Keep its entry and decoded params authoritative; standalone rendering has
  // no such request, so it still resolves against the supplied route table.
  const matched = options.matched ?? matchRoute(pathname, options.routes);

  if (!matched) return undefined;

  const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
  const match: PageRouteMatch = { entry: matched.entry, params: matched.params, query };
  const { triple } = matched.entry;
  const { request, response } = options.createHttp(match);
  const requestAbortController = createRequestAbortController(request, response);
  const store: PipelineStore = runner.buildStore
    ? runner.buildStore({ request, response })
    : { request, response };

  return runner.run(store, async () => {
    enterSharedScope(store);
    enterAdditionalSharedScope(store);

    const finish = async (bundle: PageDataBundle): Promise<TResult> =>
      options.finish ? await options.finish(bundle) : (bundle as TResult);

    const bundle: Bundle = {
      route: {
        name: matched.entry.name,
        path: matched.entry.path,
        params: match.params,
        query,
      },
      abortSignal: requestAbortController.signal,
    };

    // `route.middleware` shipped in 5.6.0 and was withdrawn (owner ruling,
    // 2026-09-08): a page declares middleware in exactly ONE place, the
    // top-level `middleware` export. A page module built before the ruling
    // that still exports `route.middleware` must fail loudly here rather than
    // have that guard silently stop running — the exact defect class this
    // workspace keeps paying to fix.
    /**
     * THE MIDDLEWARE SURFACES, TOGETHER — the one place both are documented,
     * so they cannot again be found "separately and inconsistently" (canon
     * `b79c4f55`, point 5):
     *
     * - A LAYOUT'S `middleware` export (`../routing/layout-policy.ts` — a
     *   middleware-only layout, one with no default export, is treated as a
     *   deliberate authorization boundary and composes freely). Every layout
     *   on a page's chain contributes, outermost first
     *   (`install-page-routes.ts`'s `composeLayoutLevel` folds the whole
     *   chain into `triple.layout.middleware` before this runs).
     * - The PAGE's OWN top-level `middleware` export (`triple.page.middleware`)
     *   — a page's own answer to "what does this URL require", one level
     *   below the layout instead of borrowed from it (canon `f2e514c0`).
     *
     * ONE ordering rule covers both: `LEVEL_ORDER` (app, layout, page) runs
     * outermost-first, so the page's own list always runs LAST — closest to
     * the loader. A layout's auth gate can therefore never be bypassed by a
     * page's own middleware.
     */
    for (const level of LEVEL_ORDER) {
      const middlewareForLevel = triple[level].middleware ?? [];

      for (const middleware of middlewareForLevel) {
        let output: unknown;

        try {
          output = await middleware({ request, response });
        } catch (thrown) {
          bundle.error = buildErrorRecord(
            thrown,
            designateBoundary(level, triple),
            pathname,
            undefined,
            {
              routeName: matched.entry.name,
              routePath: matched.entry.path,
              method: request.method,
              requestId: request.id,
            },
          );
          response.setStatusCode(500);
          return finish(bundle);
        }

        if (output !== undefined) {
          bundle.shortCircuit = {
            stage: "middleware",
            level,
            value: output,
            statusCode: response.statusCode,
            // Read AFTER the middleware ran (it already resolved above) — a
            // middleware that called `response.redirect()`/`.forbidden()`/
            // `.send()` itself has already written the real reply by now.
            responseSent: response.sent,
          };
          return finish(bundle);
        }
      }
    }

    const sealedShared = await sealShared(store);
    bundle.shared = sealedShared;

    const dataKeys: Record<PageLevelName, "appData" | "layoutData" | "pageData"> = {
      app: "appData",
      layout: "layoutData",
      page: "pageData",
    };

    // Stage 6 — LOADERS, root to leaf. Every level gets its OWN buffer (never
    // the live response), and a terminal result or throw prevents every lower
    // loader from starting.
    const buffers: Record<PageLevelName, LevelBuffer> = {
      app: createLevelBuffer(),
      layout: createLevelBuffer(),
      page: createLevelBuffer(),
    };

    type LoaderSignal =
      | { kind: "throw"; index: number; level: PageLevelName; thrown: unknown }
      | { kind: "validation"; index: number; errors: unknown }
      | {
          kind: "shortCircuit";
          index: number;
          level: PageLevelName;
          circuit: {
            kind: "redirect" | "notFound";
            statusCode: number;
            url?: string;
            body?: unknown;
          };
        };
    let signal: LoaderSignal | undefined;

    // Card `904a04eb`, audit §5.1: the whole non-deferred loader chain below
    // (app → layout → page loaders, plus the page's own `validation`
    // export) is bounded by ONE request-level timer, not one per loader —
    // `web.loaderTimeout` is a bound on the CHAIN. Never a `defer()`-ed
    // value (its own race lives in `defer-settlement.ts`) and never the
    // render that follows this loop.
    const loaderTimeoutMs = resolveLoaderTimeoutMs();
    let loaderTimedOut = false;
    let loaderTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    // Settles (by rejecting) AT MOST ONCE, so every await below can safely
    // race the SAME promise object as many times as the loop needs — a
    // settled promise stays settled. `0` leaves it permanently pending,
    // which is exactly "no timeout" under `Promise.race`.
    const loaderTimeoutSignal: Promise<never> = new Promise((_resolve, reject) => {
      if (loaderTimeoutMs <= 0) return;

      loaderTimeoutTimer = setTimeout(() => {
        loaderTimedOut = true;
        // Stops a loader that honours cancellation (a DB query, a fetch
        // with a plumbed-through `signal`) — the same signal already passed
        // into every loader call below.
        requestAbortController.abort();
        reject(new PageLoaderTimeoutError(loaderTimeoutMs));
      }, loaderTimeoutMs);
      loaderTimeoutTimer.unref?.();
    });
    // Never an unhandled rejection even if the chain finishes (or the loop
    // breaks for an unrelated reason) before anything ever races this.
    loaderTimeoutSignal.catch(() => undefined);

    // One "loader" phase per level that actually ran
    // (a level with no loader export is skipped below and reports nothing).
    // Resolved ONCE, outside the loop, so a disabled app pays exactly one
    // boolean check per level rather than a config read per iteration.
    const tracingEnabled = isTracingEnabled();

    for (const [index, level] of LEVEL_ORDER.entries()) {
      // Level boundary: an abandoned request does not START the next level.
      // A level already running is left alone — the framework only stops
      // BETWEEN levels (see `PipelineLoaderContext.signal`'s JSDoc).
      if (requestAbortController.signal.aborted) {
        // The synchronous window between two loader awaits where the timer
        // could in principle fire with nothing racing it yet — still a
        // proper timeout, not a silently abandoned request.
        if (loaderTimedOut && !signal) {
          signal = {
            kind: "throw",
            index,
            level,
            thrown: new PageLoaderTimeoutError(loaderTimeoutMs),
          };
        }

        break;
      }

      // The page's top-level `validation` export runs HERE, at the front of
      // the page level's own turn (card 5056fb56): app and layout loaders
      // have already run, so their data survives a rejection exactly as it
      // survives an ordinary page-loader throw — the error page renders
      // inside a layout that still has the `data` it reads — and the page's
      // OWN loader has not (the "before the loader" contract). A layout that
      // short-circuited or threw has already broken out above, so validation
      // never runs for a request that ancestor already stopped. It runs even
      // for a page with no loader: `request.validated()` is still the
      // page's to read.
      if (level === "page" && triple.page.validation) {
        try {
          const outcome = await Promise.race([
            validatePageInput(triple.page.validation, request),
            loaderTimeoutSignal,
          ]);

          if (!outcome.valid) {
            signal = { kind: "validation", index, errors: outcome.errors };
            break;
          }
        } catch (thrown) {
          if (!(thrown instanceof PageLoaderTimeoutError)) throw thrown;

          signal = { kind: "throw", index, level, thrown };
          break;
        }
      }

      const loader = triple[level].loader;

      if (!loader) continue;

      let value: unknown;
      const loaderStartedAt = tracingEnabled ? performance.now() : 0;

      try {
        value = await Promise.race([
          loader({
            request,
            response: createBufferedResponse(buffers[level]),
            shared: sealedShared,
            signal: requestAbortController.signal,
          }),
          loaderTimeoutSignal,
        ]);
      } catch (thrown) {
        signal = { kind: "throw", index, level, thrown };
        break;
      }

      if (tracingEnabled) {
        const attrs: Record<string, unknown> = { level };

        // "the layout path when present" — only the layout level ever
        // carries one, and only when this route actually has a layout file
        // (`create-page-route-handler.ts` threads it onto the entry).
        if (level === "layout" && matched.entry.layoutPath !== undefined) {
          attrs.layoutPath = matched.entry.layoutPath;
        }

        dispatchPhase(buildTracingContext(request), {
          name: "loader",
          durationMs: performance.now() - loaderStartedAt,
          attrs,
        });
      }

      if (value instanceof Response) return value;

      if (isLoaderShortCircuit(value)) {
        signal = { kind: "shortCircuit", index, level, circuit: value };
        break;
      }

      // `defer()` is a PAGE-loader-only marker. An app/layout loader's data
      // composes every page under it, including pages that never read the
      // deferred value, so deferring it would either block anyway or leave
      // the document composing around a promise nothing unwraps — treated as
      // a dev mistake, named loudly. See `DeferredInNonPageLoaderError`.
      if (isDeferred(value)) {
        if (level !== "page") {
          throw new DeferredInNonPageLoaderError(level);
        }

        const split = splitDeferredPageData(value.data);

        if (split.deferredKeys.length > 0) {
          const deferTimeoutMs = resolveDeferTimeoutMs();
          const settlements: Record<string, Promise<DeferSettlement>> = {};

          for (const key of split.deferredKeys) {
            const rawPromise = split.pageData[key] as Promise<unknown>;
            const pair = createDeferredSettlement(key, rawPromise, deferTimeoutMs, {
              routeName: matched.entry.name,
              routePath: matched.entry.path,
              pathname,
              method: request.method,
              requestId: request.id,
            });

            // The component receives the wrapped (timeout-bound) promise —
            // contract rule 4 — never the loader's raw promise, so a
            // deferred value that never settles cannot leave the response
            // waiting forever (contract rule 9).
            split.pageData[key] = pair.componentPromise;
            settlements[key] = pair.settlement;
          }

          bundle.deferredKeys = split.deferredKeys;
          bundle.deferredSettlements = settlements;
        }

        bundle[dataKeys[level]] = split.pageData;
        continue;
      }

      bundle[dataKeys[level]] = value;
    }

    if (loaderTimeoutTimer) clearTimeout(loaderTimeoutTimer);

    let committedLevels: PageLevelName[];
    /** Set only when a THROW escalated to the app boundary — forces 500. */
    let forcedStatusCode: number | undefined;
    // Nothing is committed for an abandoned request — every buffered
    // mutation (cookies, headers, the forced-status write below) is
    // discarded, no matter which level queued it. A request WE aborted for
    // our own loader-timeout bound is not abandoned — the client is still
    // there and still needs the 504 error page — so that case is excluded
    // here, deliberately, and handled entirely through the ordinary "throw"
    // signal below instead.
    const discarded = requestAbortController.signal.aborted && !loaderTimedOut;

    if (!signal) {
      committedLevels = [...LEVEL_ORDER];
    } else if (signal.kind === "throw") {
      // The throwing level's buffer is discarded; lower levels never ran.
      committedLevels = LEVEL_ORDER.slice(0, signal.index);

      const boundary = designateBoundary(signal.level, triple);
      // A failure that OWNS its own status (an error thrown with a
      // `statusCode` property) carries it through here; an ordinary throw
      // carries none and keeps the pipeline's ordinary answer, 500.
      const ownStatusCode = (signal.thrown as { statusCode?: number } | null)?.statusCode;
      bundle.error = buildErrorRecord(signal.thrown, boundary, pathname, ownStatusCode, {
        routeName: matched.entry.name,
        routePath: matched.entry.path,
        method: request.method,
        requestId: request.id,
      });

      if (boundary.boundaryLevel === "app") {
        const status = ownStatusCode ?? 500;
        if (!discarded) response.setStatusCode(status);
        forcedStatusCode = status;
      }
    } else if (signal.kind === "validation") {
      // The page level's buffer is discarded (its loader never ran); app and
      // layout commit, exactly as for a page-loader throw. Two things are
      // recorded for the SAME failure, read by two different consumers:
      // `shortCircuit` is what the DATA representation's JSON contract has
      // always carried (see `page-validation-params-query.spec.ts`); `error`
      // lets a FULL-DOCUMENT render (`render-page.ts`'s `finishRender`) go
      // through the ordinary boundary/`error.page.tsx` pipeline with its own
      // 400, instead of emitting an empty document.
      committedLevels = LEVEL_ORDER.slice(0, signal.index);

      bundle.shortCircuit = { stage: "validation", status: 400, errors: signal.errors };
      bundle.error = buildErrorRecord(
        new PageValidationFailedError(signal.errors),
        designateBoundary("page", triple),
        pathname,
        400,
        {
          routeName: matched.entry.name,
          routePath: matched.entry.path,
          method: request.method,
          requestId: request.id,
        },
      );
    } else {
      // Short-circuit: the signalling level's OWN buffer commits too
      // (inclusive); lower levels never ran.
      committedLevels = LEVEL_ORDER.slice(0, signal.index + 1);

      const circuit = signal.circuit;

      bundle.shortCircuit = {
        stage: "loaders",
        level: signal.level,
        kind: circuit.kind,
        statusCode: circuit.statusCode,
        url: circuit.url,
        body: circuit.body,
      } as unknown as PageDataBundle["shortCircuit"];
    }

    if (discarded) committedLevels = [];

    bundle.commit = commitBuffers(response, buffers, committedLevels);

    // Forced AFTER the fold: an app-boundary escalation forces 500
    // regardless of what the surviving (rootward) buffers happened to set —
    // it is the framework's answer, not a loader's.
    if (forcedStatusCode !== undefined && !discarded) bundle.commit.statusCode = forcedStatusCode;

    // Stage 8 — METADATA. Skipped entirely for a short-circuit (there is no
    // page to describe); a throw still runs it, same as before this stage 6/7
    // rewrite (a boundary still needs a title/robots answer).
    if (bundle.shortCircuit) {
      return finish(bundle);
    }

    const resolved = resolvePageMetadata({
      metadata: triple.page.metadata,
      data: bundle.pageData,
      error: bundle.error?.error,
      failed: Boolean(bundle.error),
      shared: sealedShared,
      deferredKeys: bundle.deferredKeys,
      pagePath: bundle.route.path,
    });

    bundle.metadata = resolved.metadata;

    if (resolved.thrown !== undefined) {
      const boundary = designateBoundary("page", triple);
      bundle.error = buildErrorRecord(resolved.thrown, boundary, bundle.route.path, undefined, {
        routeName: matched.entry.name,
        routePath: matched.entry.path,
        method: request.method,
        requestId: request.id,
      });

      if (boundary.boundaryLevel === "app") response.setStatusCode(500);
    }

    return finish(bundle);
  });
}
