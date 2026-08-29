import { Response } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { enterSharedScope, sealShared } from "../shared";
import { enterAdditionalSharedScope, requireRunner } from "./page-context";
import { matchRoute } from "./match-page-route";
import { resolvePageMetadata } from "./resolve-page-metadata";
import { resolveValidationData } from "./resolve-validation-data";
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

/** Widens `PageDataBundle` with the two fields stage 6/7 populate. */
type Bundle = PageDataBundle & {
  commit?: PageResponseCommit;
  shortCircuit?: PageDataBundle["shortCircuit"] & {
    kind?: "redirect" | "notFound";
    url?: string;
    body?: unknown;
  };
};

export async function executePageRequest<TResult = PageDataBundle>(
  options: ExecutePageRequestOptions<TResult>,
): Promise<TResult | Response | undefined> {
  const runner = requireRunner();
  const [pathname, queryString] = options.url.split("?");
  const matched = matchRoute(pathname, options.routes);

  if (!matched) return undefined;

  const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
  const match: PageRouteMatch = { entry: matched.entry, params: matched.params, query };
  const { triple } = matched.entry;
  const { request, response } = options.createHttp(match);
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
    };

    for (const level of LEVEL_ORDER) {
      for (const middleware of triple[level].middleware ?? []) {
        let output: unknown;

        try {
          output = await middleware({ request, response });
        } catch (thrown) {
          bundle.error = buildErrorRecord(thrown, designateBoundary(level, triple), pathname);
          response.setStatusCode(500);
          return finish(bundle);
        }

        if (output !== undefined) {
          bundle.shortCircuit = {
            stage: "middleware",
            level,
            value: output,
            statusCode: response.statusCode,
          };
          return finish(bundle);
        }
      }
    }

    const validation = triple.page.validation;

    if (validation?.schema) {
      const data = resolveValidationData(validation.validating, request);
      const result = await v.validate(validation.schema, data);

      if (result.isValid && result.data) {
        request.setValidatedData(result.data);
      }

      if (!result.isValid) {
        bundle.shortCircuit = { stage: "validation", status: 422, errors: result.errors };
        return finish(bundle);
      }
    }

    const sealedShared = await sealShared(store);
    bundle.shared = sealedShared;

    const dataKeys: Record<PageLevelName, "appData" | "layoutData" | "pageData"> = {
      app: "appData",
      layout: "layoutData",
      page: "pageData",
    };

    // Stage 6 — LOADERS, in parallel: every level gets its OWN buffer (never
    // the live response), and every level starts before any of them finishes
    // (`.map` invokes each async loader synchronously up to its first
    // `await`, and `Promise.allSettled` never re-orders that).
    const buffers: Record<PageLevelName, LevelBuffer> = {
      app: createLevelBuffer(),
      layout: createLevelBuffer(),
      page: createLevelBuffer(),
    };

    const settled = await Promise.allSettled(
      LEVEL_ORDER.map(level => {
        const loader = triple[level].loader;

        if (!loader) return Promise.resolve({ level, skipped: true as const });

        // `try` here, not just `.catch()` on the promise chain — a
        // non-async loader can throw SYNCHRONOUSLY, before ever returning a
        // promise for `.then()`/`.catch()` to attach to.
        try {
          return Promise.resolve(
            loader({
              request,
              response: createBufferedResponse(buffers[level]),
              shared: sealedShared,
            }),
          ).then(value => ({ level, value }));
        } catch (thrown) {
          return Promise.reject(thrown);
        }
      }),
    );

    // The first abnormal outcome (thrown, or a loader short-circuit), the
    // level closest to the root wins — `LEVEL_ORDER` is already root→leaf, so
    // "first" in iteration order IS "closest to the root".
    let signalIndex = -1;
    let signalKind: "throw" | "shortCircuit" | undefined;
    let signalThrown: unknown;
    let signalCircuit:
      | { kind: "redirect" | "notFound"; statusCode: number; url?: string; body?: unknown }
      | undefined;

    for (let index = 0; index < LEVEL_ORDER.length; index++) {
      const level = LEVEL_ORDER[index];
      const result = settled[index];

      if (result.status === "rejected") {
        if (signalIndex === -1) {
          signalIndex = index;
          signalKind = "throw";
          signalThrown = result.reason;
        }
        continue;
      }

      const outcome = result.value as
        | { level: PageLevelName; skipped: true }
        | { level: PageLevelName; value: unknown };

      if ("skipped" in outcome) continue;

      if (outcome.value instanceof Response) return outcome.value;

      if (isLoaderShortCircuit(outcome.value)) {
        if (signalIndex === -1) {
          signalIndex = index;
          signalKind = "shortCircuit";
          signalCircuit = outcome.value;
        }
        continue;
      }

      // Plain data. Discarded below if it turns out to be leafward of a
      // THROW signal at a rootward level; kept as-is for a short-circuit
      // (that discard is explicit, further down) and for the normal path.
      bundle[dataKeys[level]] = outcome.value;
    }

    let committedLevels: PageLevelName[];
    /** Set only when a THROW escalated to the app boundary — forces 500. */
    let forcedStatusCode: number | undefined;

    if (signalIndex === -1) {
      committedLevels = [...LEVEL_ORDER];
    } else if (signalKind === "throw") {
      // The throwing level's buffer is discarded WITH its siblings' below it;
      // only rootward levels commit. Data leafward of the throw stays (it was
      // already assigned above, from `allSettled`) — only its BUFFER is cut.
      committedLevels = LEVEL_ORDER.slice(0, signalIndex);

      const boundary = designateBoundary(LEVEL_ORDER[signalIndex], triple);
      bundle.error = buildErrorRecord(signalThrown, boundary, pathname);

      // Data assigned above for the throwing level itself is impossible (its
      // promise rejected), but a level "skipped"/never wrote one either — no
      // cleanup needed there. Levels leafward of the throw whose loaders
      // FULFILLED already have their data on the bundle; that is correct
      // (`request-lifecycle.md` stage 7: "the throwing layer's buffer is
      // discarded with its siblings' below it" — data is not a buffer).

      if (boundary.boundaryLevel === "app") {
        response.setStatusCode(500);
        forcedStatusCode = 500;
      }
    } else {
      // Short-circuit: the signalling level's OWN buffer commits too
      // (inclusive), and everything leafward is discarded — buffer AND data.
      committedLevels = LEVEL_ORDER.slice(0, signalIndex + 1);

      for (let index = signalIndex + 1; index < LEVEL_ORDER.length; index++) {
        delete bundle[dataKeys[LEVEL_ORDER[index]]];
      }

      const circuit = signalCircuit!;

      bundle.shortCircuit = {
        stage: "loaders",
        level: LEVEL_ORDER[signalIndex],
        kind: circuit.kind,
        statusCode: circuit.statusCode,
        url: circuit.url,
        body: circuit.body,
      } as unknown as PageDataBundle["shortCircuit"];
    }

    bundle.commit = commitBuffers(response, buffers, committedLevels);

    // Forced AFTER the fold: an app-boundary escalation forces 500
    // regardless of what the surviving (rootward) buffers happened to set —
    // it is the framework's answer, not a loader's.
    if (forcedStatusCode !== undefined) bundle.commit.statusCode = forcedStatusCode;

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
    });

    bundle.metadata = resolved.metadata;

    if (resolved.thrown !== undefined) {
      const boundary = designateBoundary("page", triple);
      bundle.error = buildErrorRecord(resolved.thrown, boundary, bundle.route.path);

      if (boundary.boundaryLevel === "app") response.setStatusCode(500);
    }

    return finish(bundle);
  });
}
