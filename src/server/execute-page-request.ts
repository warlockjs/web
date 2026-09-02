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

    // Stage 6 — LOADERS, root to leaf. Every level gets its OWN buffer (never
    // the live response), and a terminal result or throw prevents every lower
    // loader from starting.
    const buffers: Record<PageLevelName, LevelBuffer> = {
      app: createLevelBuffer(),
      layout: createLevelBuffer(),
      page: createLevelBuffer(),
    };

    let signalIndex = -1;
    let signalKind: "throw" | "shortCircuit" | undefined;
    let signalThrown: unknown;
    let signalCircuit:
      | { kind: "redirect" | "notFound"; statusCode: number; url?: string; body?: unknown }
      | undefined;

    for (let index = 0; index < LEVEL_ORDER.length; index++) {
      const level = LEVEL_ORDER[index];
      const loader = triple[level].loader;

      if (!loader) continue;

      let value: unknown;

      try {
        value = await loader({
          request,
          response: createBufferedResponse(buffers[level]),
          shared: sealedShared,
        });
      } catch (thrown) {
        signalIndex = index;
        signalKind = "throw";
        signalThrown = thrown;
        break;
      }

      if (value instanceof Response) return value;

      if (isLoaderShortCircuit(value)) {
        signalIndex = index;
        signalKind = "shortCircuit";
        signalCircuit = value;
        break;
      }

      bundle[dataKeys[level]] = value;
    }

    let committedLevels: PageLevelName[];
    /** Set only when a THROW escalated to the app boundary — forces 500. */
    let forcedStatusCode: number | undefined;

    if (signalIndex === -1) {
      committedLevels = [...LEVEL_ORDER];
    } else if (signalKind === "throw") {
      // The throwing level's buffer is discarded; lower levels never ran.
      committedLevels = LEVEL_ORDER.slice(0, signalIndex);

      const boundary = designateBoundary(LEVEL_ORDER[signalIndex], triple);
      bundle.error = buildErrorRecord(signalThrown, boundary, pathname);

      if (boundary.boundaryLevel === "app") {
        response.setStatusCode(500);
        forcedStatusCode = 500;
      }
    } else {
      // Short-circuit: the signalling level's OWN buffer commits too
      // (inclusive); lower levels never ran.
      committedLevels = LEVEL_ORDER.slice(0, signalIndex + 1);

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
