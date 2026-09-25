import {
  buildTracingContext,
  config,
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
import { beginLayoutLoaderCapture, endLayoutLoaderCapture } from "./layout-loader-capture";
import { matchRoute } from "./match-page-route";
import { resolvePageMetadata } from "./resolve-page-metadata";
import { resolveValidationData } from "./resolve-validation-data";
import { resolvePageValidationInput } from "./resolve-route-validation-input";
import { DEFAULT_ACTION_NAME, resolveActionInput } from "./resolve-action-input";
import { toActionState, type ActionState, type SealActionError } from "./action-state";
import { isDataRequest, WARLOCK_DATA_REQUEST_HEADER } from "../routing/data-request";
import { PageValidationFailedError } from "./page-validation-failed-error";
import { resolveThrownHttpStatus } from "./resolve-thrown-http-status";
import { DeferredInNonPageLoaderError, isDeferred, splitDeferredPageData } from "../loaders/defer";
import { createDeferredSettlement, type DeferSettlement } from "./defer-settlement";
import { resolveDeferTimeoutMs, resolveLoaderTimeoutMs } from "./streaming-config";
import { PageLoaderTimeoutError } from "./page-loader-timeout-error";
import {
  buildErrorRecord,
  commitBuffers,
  createActionResponse,
  createBufferedResponse,
  createLevelBuffer,
  designateBoundary,
  isActionFailure,
  isLoaderShortCircuit,
  LEVEL_ORDER,
  type LevelBuffer,
  type PageResponseCommit,
} from "./settle-page-response";
import { isPageRedirectSignal } from "../session/page-redirect-signal";
import { SessionResolvedTooLateError } from "../session/session-resolved-too-late-error";
import type { SessionResolver } from "../session/session.types";
import type {
  ExecutePageRequestOptions,
  PipelineLoaderContext,
  PageDataBundle,
  PageLevelName,
  PageRouteMatch,
  PageTripleModule,
  PipelineStore,
} from "./execute-page-request.types";
import type { SharedContext } from "../index";

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
 * Stage 2.5 is the final point at which a session resolver may renew a
 * cookie. `Response` deliberately exposes the underlying raw response for
 * streaming, and Node marks that response once `writeHead` has run.
 */
function hasCommittedResponseHeaders(response: Response): boolean {
  const raw = response.baseResponse?.raw as
    | { headersSent?: boolean; writableEnded?: boolean }
    | undefined;

  return raw?.headersSent === true || raw?.writableEnded === true;
}

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

type MiddlewareChainOptions = {
  triple: PageRouteMatch["entry"]["triple"];
  request: Request;
  response: Response;
  pathname: string;
  routeName: string;
  routePath: string;
  /** Stage 2.5's session, handed to action middleware; absent without `web.session`. */
  session?: PipelineLoaderContext["session"];
};

type MiddlewareHalt = Pick<Bundle, "error" | "shortCircuit">;

/**
 * Runs app, layout and page middleware, outermost first (`LEVEL_ORDER`), and
 * reports why the chain stopped: a thrown middleware (status already forced
 * to 500) or a middleware that returned a value. `undefined` means every
 * middleware passed.
 */
async function runMiddlewareChain(
  options: MiddlewareChainOptions,
): Promise<MiddlewareHalt | undefined> {
  const { triple, request, response, pathname, routeName, routePath, session } = options;

  for (const level of LEVEL_ORDER) {
    for (const middleware of triple[level].middleware ?? []) {
      let output: unknown;

      try {
        // `session` rides along for action middleware only; HttpContext predates it.
        const middlewareContext = session === undefined ? { request, response } : { request, response, session };

        output = await middleware(middlewareContext);
      } catch (thrown) {
        // Same rule as a loader throw: a thrown core `HttpError` owns its
        // status, and a 4xx is the visitor's affair — never reported.
        const resolvedStatus = resolveThrownHttpStatus(thrown);
        const isClientError = resolvedStatus !== undefined && resolvedStatus < 500;
        const error = buildErrorRecord(
          thrown,
          designateBoundary(level, triple),
          pathname,
          resolvedStatus,
          { routeName, routePath, method: request.method, requestId: request.id },
          !isClientError,
        );

        response.setStatusCode(resolvedStatus ?? 500);

        return { error };
      }

      if (output !== undefined) {
        return {
          shortCircuit: {
            stage: "middleware",
            level,
            value: output,
            statusCode: response.statusCode,
            // Read AFTER the middleware ran (it already resolved above) — a
            // middleware that called `response.redirect()`/`.forbidden()`/
            // `.send()` itself has already written the real reply by now.
            responseSent: response.sent,
          },
        };
      }
    }
  }

  return undefined;
}

type ActionStageOutcome =
  | { kind: "halt"; halted: MiddlewareHalt }
  | { kind: "response"; response: Response }
  /** The request is finished before the loaders; `bundle.shortCircuit` says why. */
  | { kind: "stop" }
  | { kind: "throw"; thrown: unknown }
  | { kind: "validation"; errors: unknown }
  | {
      kind: "shortCircuit";
      circuit: { kind: "redirect" | "notFound"; statusCode: number; url?: string; body?: unknown };
    }
  | { kind: "continue"; pageValidated: boolean };

type ActionStageOptions = {
  triple: PageRouteMatch["entry"]["triple"];
  request: Request;
  response: Response;
  pathname: string;
  routeName: string;
  routePath: string;
  bundle: Bundle;
  buffer: LevelBuffer;
  shared: SharedContext;
  session?: PipelineLoaderContext["session"];
};

/**
 * Stage 5b — ACTION (5.21 page actions), for a POST to a page that declares
 * `action`/`actions`. It runs after the app/layout/page middleware and the
 * shared seal, and before the loaders (design §2.3):
 *
 *   1. `config.action.middleware`;
 *   2. the page's own `validation` (params/query) — a failure is today's 400;
 *   3. action validation against the body only;
 *   4. the action itself;
 *   5. the page's validated data is restored, because the loaders re-run.
 *
 * The outcome lands on `bundle.actionData`; a request that must not reach the
 * loaders (a failed action on a data request, an unknown `_action`) records
 * `bundle.shortCircuit = { stage: "action" }` and answers `stop`.
 */
async function runActionStage(options: ActionStageOptions): Promise<ActionStageOutcome> {
  const { triple, request, response, bundle, buffer } = options;
  const page = triple.page;
  const resolved = resolveActionInput(request);
  const isDefault = resolved.name === DEFAULT_ACTION_NAME;
  const handler = !resolved.validName
    ? undefined
    : isDefault
      ? page.action
      : page.actions !== undefined && Object.hasOwn(page.actions, resolved.name)
        ? page.actions[resolved.name]
        : undefined;
  const wantsData = isDataRequest(request.header(WARLOCK_DATA_REQUEST_HEADER, undefined));

  if (handler === undefined) {
    bundle.shortCircuit = { stage: "action", statusCode: wantsData ? 404 : 400 };

    return { kind: "stop" };
  }

  const actionConfig = isDefault ? page.actionConfig : page.actionsConfig?.[resolved.name];

  if (actionConfig?.middleware?.length) {
    const halted = await runMiddlewareChain({
      ...options,
      triple: { app: {}, layout: {}, page: { middleware: actionConfig.middleware } },
    });

    if (halted) return { kind: "halt", halted };
  }

  let pageValidated = false;

  if (page.validation) {
    const outcome = await validatePageInput(page.validation, request);

    if (!outcome.valid) return { kind: "validation", errors: outcome.errors };

    pageValidated = true;
  }

  const pageInput = request.validated();
  const redactValues = config.get("web.forms.redactValues") as readonly string[] | undefined;
  const stateOptions = { action: resolved.name, redactValues, values: resolved.input };
  const restorePageInput = () => request.setValidatedData(pageInput);
  const fail = (state: ActionState): ActionStageOutcome => {
    bundle.actionData = state;
    restorePageInput();

    if (!wantsData) return { kind: "continue", pageValidated };

    bundle.shortCircuit = { stage: "action", statusCode: state.status };

    return { kind: "stop" };
  };

  if (actionConfig?.validation) {
    const result = await v.validate(
      actionConfig.validation,
      resolved.input,
      environment() === "production"
        ? { ...getSealConfig(), redactValue: REDACTED_VALUE }
        : undefined,
    );

    if (!result.isValid) {
      return fail(
        toActionState(
          { kind: "errors", errors: result.errors as SealActionError[] },
          stateOptions,
        ),
      );
    }

    request.setValidatedData(result.data ?? {});
  }

  let value: unknown;

  try {
    value = await handler({
      request,
      response: createActionResponse(buffer),
      shared: options.shared,
      pageInput,
      signal: bundle.abortSignal,
      ...(options.session === undefined ? {} : { session: options.session }),
    });
  } catch (thrown) {
    return { kind: "throw", thrown };
  }

  restorePageInput();

  if (value instanceof Response) return { kind: "response", response: value };

  if (isLoaderShortCircuit(value)) return { kind: "shortCircuit", circuit: value };

  if (isActionFailure(value)) {
    return fail(toActionState({ kind: "signal", signal: value }, stateOptions));
  }

  bundle.actionData = toActionState({ kind: "success", data: value }, stateOptions);

  return { kind: "continue", pageValidated };
}

export type PageMiddlewareGateOutcome = "passed" | "sent" | "blocked";

/**
 * The middleware gate for a page-cache HIT (`serverCache`): the cache sits
 * BEHIND middleware, so a HIT must not be served to a request an app, layout or
 * page middleware would have stopped. `passed` = serve the HIT; `sent` = a
 * middleware already wrote the whole reply; `blocked` = a middleware halted
 * without replying, so the caller falls through to the full pipeline (which
 * renders that outcome exactly as it does on a MISS).
 */
export async function runPageMiddlewareGate(
  options: MiddlewareChainOptions,
): Promise<PageMiddlewareGateOutcome> {
  const { request, response } = options;
  const runner = requireRunner();
  const store: PipelineStore = runner.buildStore
    ? runner.buildStore({ request, response })
    : { request, response };

  return runner.run(store, async () => {
    enterSharedScope(store);
    enterAdditionalSharedScope(store);

    const halted = await runMiddlewareChain(options);

    if (halted === undefined) return "passed";

    const circuit = halted.shortCircuit;

    return circuit?.stage === "middleware" && circuit.responseSent === true ? "sent" : "blocked";
  });
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

    // Stage 2.5 — SESSION. Only when `web.session` is configured. Resolved
    // ONCE, before the middleware loop and before any header is committed, so a
    // renewal cookie can still be sent. A guest is `{ user: null }` and leaves
    // `authDerived` untouched (the render stays cache-eligible); a signed-in
    // user ships the projection only and marks the request auth-derived.
    let stageSession: PipelineLoaderContext["session"];
    const sessionResolver = config.get("web.session") as SessionResolver | undefined;

    if (sessionResolver) {
      try {
        if (hasCommittedResponseHeaders(response)) {
          throw new SessionResolvedTooLateError();
        }

        const resolved = await sessionResolver.resolve(request, response);

        if (resolved) {
          if (request.locals) request.locals.authDerived = true;

          stageSession = { user: resolved.user, model: resolved.model };
        } else {
          stageSession = { user: null, model: null };
        }
      } catch (thrown) {
        const resolvedStatus = resolveThrownHttpStatus(thrown);
        const isClientError = resolvedStatus !== undefined && resolvedStatus < 500;

        bundle.error = buildErrorRecord(
          thrown,
          designateBoundary("app", triple),
          pathname,
          resolvedStatus,
          {
            routeName: matched.entry.name,
            routePath: matched.entry.path,
            method: request.method,
            requestId: request.id,
          },
          !isClientError,
        );
        response.setStatusCode(resolvedStatus ?? 500);

        return finish(bundle);
      }

      bundle.session = { user: stageSession.user };
    }

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
    const halted = await runMiddlewareChain({
      triple,
      request,
      response,
      pathname,
      routeName: matched.entry.name,
      routePath: matched.entry.path,
    });

    if (halted) {
      Object.assign(bundle, halted);
      return finish(bundle);
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
    // Never serialized: this exists only from the composed layout loader's
    // completion through stage 8, where each metadata definition receives the
    // value produced by its matching layout loader.
    let capturedLayoutData: readonly unknown[] | undefined;
    // Set by stage 5b when the page validation already ran there, so the
    // loader loop does not run (and re-validate) it a second time.
    let pageValidationDone = false;

    // Stage 5b - ACTION. Only a POST to a page that declares an action gets
    // here (install-page-routes registers no other POST), so a page without
    // one is untouched.
    if (request.method === "POST" && (triple.page.action || triple.page.actions)) {
      const outcome = await runActionStage({
        triple,
        request,
        response,
        pathname,
        routeName: matched.entry.name,
        routePath: matched.entry.path,
        bundle,
        buffer: buffers.page,
        shared: sealedShared,
        session: stageSession,
      });

      if (outcome.kind === "halt") {
        Object.assign(bundle, outcome.halted);
        return finish(bundle);
      }

      if (outcome.kind === "response") return outcome.response;

      if (outcome.kind === "stop") {
        bundle.commit = commitBuffers(response, buffers, [...LEVEL_ORDER]);

        return finish(bundle);
      }

      if (outcome.kind === "throw") {
        signal = { kind: "throw", index: 2, level: "page", thrown: outcome.thrown };
      } else if (outcome.kind === "validation") {
        signal = { kind: "validation", index: 2, errors: outcome.errors };
      } else if (outcome.kind === "shortCircuit") {
        signal = { kind: "shortCircuit", index: 2, level: "page", circuit: outcome.circuit };
      } else {
        pageValidationDone = outcome.pageValidated;
      }
    }

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
      // Stage 5b already ended the request (an action redirect, throw or a
      // failed page validation): no loader runs.
      if (signal) break;

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
      if (level === "page" && triple.page.validation && !pageValidationDone) {
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
      const loaderContext = {
        request,
        response: createBufferedResponse(buffers[level]),
        shared: sealedShared,
        signal: requestAbortController.signal,
        ...(stageSession === undefined ? {} : { session: stageSession }),
      };
      const layoutValues =
        level === "layout" && triple.layout.layoutMetadata !== undefined
          ? new Array<unknown>(triple.layout.layoutMetadata.length)
          : undefined;

      if (layoutValues !== undefined) beginLayoutLoaderCapture(loaderContext, layoutValues);

      try {
        value = await Promise.race([loader(loaderContext), loaderTimeoutSignal]);
      } catch (thrown) {
        // `requireUser(ctx)` for a guest: the ordinary redirect short-circuit.
        signal = isPageRedirectSignal(thrown)
          ? {
              kind: "shortCircuit",
              index,
              level,
              circuit: { kind: "redirect", statusCode: thrown.statusCode, url: thrown.url },
            }
          : { kind: "throw", index, level, thrown };
        break;
      } finally {
        if (layoutValues !== undefined) {
          capturedLayoutData = layoutValues;
          endLayoutLoaderCapture(loaderContext);
        }
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
      // A failure that OWNS its own status — a framework error carrying its
      // own `statusCode`, or a thrown core `@warlock.js/core` `HttpError`
      // (`ResourceNotFoundError`, `ForbiddenError`, `BadRequestError`, …) —
      // carries it through here; an ordinary throw resolves to `undefined`
      // and keeps the pipeline's ordinary answer, 500 (card `f2b8953d`).
      const resolvedStatus = resolveThrownHttpStatus(signal.thrown);

      if (resolvedStatus === 404) {
        // Same path a loader's own `response.notFound()` already takes —
        // the throwing level's buffer commits inclusively, exactly like an
        // explicit short-circuit, and the 404 page renders with no
        // `bundle.error` at all: never a parallel notFound implementation.
        committedLevels = LEVEL_ORDER.slice(0, signal.index + 1);
        bundle.shortCircuit = {
          stage: "loaders",
          level: signal.level,
          kind: "notFound",
          statusCode: 404,
          url: undefined,
          body: undefined,
        };
      } else {
        // The throwing level's buffer is discarded; lower levels never ran.
        committedLevels = LEVEL_ORDER.slice(0, signal.index);

        const boundary = designateBoundary(signal.level, triple);
        // A resolved 4xx is the visitor's own affair, not a server fault —
        // it never reaches `web.errors.report()`/the stderr floor, only a
        // debug breadcrumb (`buildErrorRecord`'s `report` argument).
        const isClientError = resolvedStatus !== undefined && resolvedStatus < 500;

        bundle.error = buildErrorRecord(
          signal.thrown,
          boundary,
          pathname,
          resolvedStatus,
          {
            routeName: matched.entry.name,
            routePath: matched.entry.path,
            method: request.method,
            requestId: request.id,
          },
          !isClientError,
        );

        if (boundary.boundaryLevel === "app") {
          const status = resolvedStatus ?? 500;
          if (!discarded) response.setStatusCode(status);
          forcedStatusCode = status;
        }
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
        false,
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
      layoutRobots:
        typeof triple.layout.metadata === "function" ? undefined : triple.layout.metadata?.robots,
      data: bundle.pageData,
      error: bundle.error?.error,
      failed: Boolean(bundle.error),
      shared: sealedShared,
      deferredKeys: bundle.deferredKeys,
      pagePath: bundle.route.path,
      ancestors: [
        { kind: "root", metadata: triple.app.metadata, data: bundle.appData },
        ...(triple.layout.layoutMetadata !== undefined
          ? triple.layout.layoutMetadata.map((metadata, index) => ({
              kind: "layout" as const,
              metadata,
              data: capturedLayoutData?.[index],
            }))
          : [
              {
                kind: "layout" as const,
                metadata: triple.layout.metadata,
                data: bundle.layoutData,
              },
            ]),
      ],
    });

    bundle.metadata = resolved.metadata;

    if (Object.hasOwn(resolved, "thrown")) {
      const boundary = designateBoundary(resolved.throwingLevel ?? "page", triple);
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
