import { Response } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { enterSharedScope, sealShared } from "../shared";
import { connectRequestSearch } from "../routing/query-string";
import { enterAdditionalSharedScope, requireRunner } from "./page-context";
import { matchRoute } from "./match-page-route";
import { resolvePageMetadata } from "./resolve-page-metadata";
import { resolveValidationData } from "./resolve-validation-data";
import { resolvePageValidationInput } from "./resolve-route-validation-input";
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

export async function executePageRequest<TResult = PageDataBundle>(
  options: ExecutePageRequestOptions<TResult>,
): Promise<TResult | Response | undefined> {
  const runner = requireRunner();

  wireRequestSearch();
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

    if (validation) {
      const legacyValidation = "schema" in validation || "validating" in validation;
      const schema = legacyValidation
        ? validation.schema
        : v.object({
            ...(validation.params === undefined ? {} : { params: validation.params }),
            ...(validation.query === undefined ? {} : { query: validation.query }),
          });

      if (schema) {
        const data = legacyValidation
          ? resolveValidationData(validation.validating, request)
          : resolvePageValidationInput(request);
        const result = await v.validate(schema, data);

        if (result.isValid && result.data) {
          request.setValidatedData(result.data);
        }

        if (!result.isValid) {
          bundle.shortCircuit = { stage: "validation", status: 400, errors: result.errors };
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

    let signalIndex = -1;
    let signalKind: "throw" | "shortCircuit" | undefined;
    let signalThrown: unknown;
    let signalCircuit:
      | { kind: "redirect" | "notFound"; statusCode: number; url?: string; body?: unknown }
      | undefined;

    for (let index = 0; index < LEVEL_ORDER.length; index++) {
      const level = LEVEL_ORDER[index];

      // `route.validate` — the PAGE's own declared schema, over `{ params,
      // query }` kept as two separate keys (canon `b79c4f55`, point 1). Runs
      // HERE, at the front of the page level's own turn: app and layout
      // loaders have already run (their data survives a rejection, exactly
      // as an ordinary page-level throw leaves them untouched) and the
      // page's OWN loader has not (mirrors the top-level `validation`
      // export's "before the loader" contract). A failure is folded into the
      // ordinary THROW signal below rather than given a fourth code path: it
      // designates a boundary and renders the application's error
      // page/boundary with status 400 (point 2) — a page is a document, not
      // an API endpoint, so this must never answer a raw JSON body.
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
      // A failure that OWNS its own status (a `RouteValidationError`'s 400)
      // carries it through here; an ordinary throw carries none and keeps
      // the pipeline's ordinary answer, 500.
      const ownStatusCode = (signalThrown as { statusCode?: number } | null)?.statusCode;
      bundle.error = buildErrorRecord(signalThrown, boundary, pathname, ownStatusCode);

      if (boundary.boundaryLevel === "app") {
        const status = ownStatusCode ?? 500;
        response.setStatusCode(status);
        forcedStatusCode = status;
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
