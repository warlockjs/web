import { v } from "@warlock.js/seal";
import { createBufferedResponse, isLoaderShortCircuit } from "./buffered-response";
import type { LoaderShortCircuitSignal } from "./buffered-response";
import { enterSharedScope, sealShared, shared } from "../shared";
import { enterAdditionalSharedScope, requireRunner } from "./page-context";
import { matchRoute } from "./match-page-route";
import { resolvePageMetadata } from "./resolve-page-metadata";
import { resolveValidationData } from "./resolve-validation-data";
import {
  buildErrorRecord,
  commitBuffers,
  designateBoundary,
  LEVEL_ORDER,
} from "./settle-page-response";
import type {
  ExecutePageRequestOptions,
  PageDataBundle,
  PageLevelName,
  PageRouteMatch,
  PipelineResponse,
  PipelineStore,
} from "./execute-page-request.types";

/**
 * Pipeline stages 1–8 of a page request; stages 9–10 (render/emit) are the
 * render slice's, and this ends at the DATA BUNDLE.
 *
 * The founding sentence governs the shape — a page route is an ordinary Warlock
 * route whose handler renders React instead of returning JSON — so every stage
 * mirrors what core already does for an API request: core's own ALS store and
 * `run`, core's middleware short-circuit rule (`output !== undefined`), and
 * `validateAll`'s validation with its 422, recorded as a designation because
 * sending is the emit's job.
 *
 * The pieces live beside this file: `page-context.ts` (stage 2 wiring),
 * `match-page-route.ts` (stage 1), `resolve-validation-data.ts` (stage 4),
 * `settle-page-response.ts` (stage 7), `resolve-page-metadata.ts` (stage 8).
 */

export * from "./execute-page-request.types";
export { connectPageContext, connectPageSharedScope } from "./page-context";
export { buildErrorRecord, designateBoundary } from "./settle-page-response";

export async function executePageRequest<TResult = PageDataBundle>(
  options: ExecutePageRequestOptions<TResult>,
): Promise<TResult | undefined> {
  const runner = requireRunner();

  // ── stage 1 · MATCH ─────────────────────────────────────────────────────
  const [pathname, queryString] = options.url.split("?");
  const matched = matchRoute(pathname, options.routes);

  if (!matched) return undefined;

  const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
  const match: PageRouteMatch = { entry: matched.entry, params: matched.params, query };
  const { triple } = matched.entry;

  const { request, response } = options.createHttp(match);

  // ── stage 2 · CONTEXT ───────────────────────────────────────────────────
  // Core's own store shape, built by core's own `buildStore` when the runner
  // carries one. `enterSharedScope` keys the shared target by this exact object.
  const store: PipelineStore = runner.buildStore
    ? runner.buildStore({ request, response })
    : { request, response };

  return await runner.run(store, async () => {
    enterSharedScope(store);
    enterAdditionalSharedScope(store);

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
    // Sequential, outermost first. Middleware gets the REAL request/response —
    // it runs alone, before any parallelism — and is the only writer of `shared`.
    for (const level of LEVEL_ORDER) {
      for (const middleware of triple[level].middleware ?? []) {
        let output: unknown;

        try {
          output = await middleware({ request, response });
        } catch (thrown) {
          /*
            A middleware throw means NOTHING was served: no loaders ran, no
            buffers exist. The "a nested boundary keeps the committed status"
            rule assumes the page was substantially served, so it cannot apply
            here — the framework forces 500 whichever level the boundary
            designates to.
          */
          bundle.error = buildErrorRecord(thrown, designateBoundary(level, triple), pathname);
          bundle.commit = commitBuffers(response, [], 500);

          return finish(bundle);
        }

        if (output !== undefined) {
          bundle.shortCircuit = {
            stage: "middleware",
            level,
            value: output,
            statusCode: (response as PipelineResponse & { statusCode?: number }).statusCode,
          };

          return finish(bundle);
        }
      }
    }

    // ── stage 4 · VALIDATION ──────────────────────────────────────────────
    // Failure stops before the seal: a 422 designation in the bundle, since
    // sending is the emit slice's job.
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
    // From here `shared` is immutable and identical for every reader. The
    // bundle carries `sealShared`'s RETURN, never a proxy re-read.
    const sealedShared = await sealShared(store);

    bundle.shared = sealedShared;

    // ── stage 6 · LOADERS ─────────────────────────────────────────────────
    // Parallel, each with its OWN buffered response. Loaders never read each
    // other and cannot write `shared` — it is sealed, and a write throws.
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
    // Walk root→leaf for the first abnormal outcome. A throw discards the
    // throwing layer's buffer and everything below it, and the framework owns
    // the status. A redirect/notFound commits the signalling layer's own buffer
    // and discards its siblings below.
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

    // A throw elsewhere never costs a healthy layer its data. Levels leafward
    // of a short-circuit go, because they will not render.
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

      // Commit strictly rootward of the throw. A NESTED boundary keeps the
      // committed status — the page was substantially served; only the ROOT
      // boundary forces 5xx.
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
    // Skipped entirely after a loader short-circuit: a redirect/notFound answer
    // has no page render to describe.
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
        The page's own metadata function threw with no earlier error to mask.
        Record it exactly as a loader throw, so the boundary renders and the
        framework keeps the status — rather than letting it escape stage 8,
        where nothing is left to catch it and stage 7's buffers are already
        committed.
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
