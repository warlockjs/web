import { stringify } from "devalue";

import type { Request, Response } from "@warlock.js/core";

import { DATA_RESPONSE_CONTENT_TYPE } from "../../routing/data-request";
import type { PageCacheOptIn } from "../../routing/route-identity";
import { buildHydrationPayload } from "../build-hydration-payload";
import type { BufferedCookie } from "../execute-page-request";
import type { ErrorPageModuleLoader } from "../error-page";
import type { RouteTranslations } from "../route-translations";
import { pageVaryHeader } from "../page-vary-header";
import { renderPageFailure } from "../render-page";
import { applyCommit } from "./apply-commit";

/**
 * Renders and sends the failure representation for a `thrown` that escaped
 * the ordinary page pipeline (a module-load or register failure — the
 * pipeline's own boundary machinery inside `renderPageRequest` already
 * absorbs a loader/render throw). Reuses the same request/response pair so
 * headers, nonce and response ownership remain exactly what the ordinary
 * path would have produced.
 *
 * Callers must wrap this in their own nested try/catch: if rendering the
 * failure page fails too, the ORIGINAL throw must escape, not this one — see
 * `create-page-route-handler.ts`'s catch block, which this function's body
 * was extracted from unchanged.
 */
export async function writePageFailureResponse(options: {
  name: string;
  request: Request;
  response: Response;
  thrown: unknown;
  loadErrorPage?: ErrorPageModuleLoader;
  routeTranslations?: RouteTranslations;
  getRouteTranslations?: import("../route-translations").RouteTranslationsResolver;
  appFile?: string;
  errorPageFile?: string;
  stylesheetUrls?: readonly string[];
  hydrationClientModuleUrl?: string;
  cache?: PageCacheOptIn;
  wantsData: boolean;
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void;
}): Promise<void> {
  const {
    name,
    request,
    response,
    thrown,
    loadErrorPage,
    routeTranslations,
    getRouteTranslations,
    appFile,
    errorPageFile,
    stylesheetUrls,
    hydrationClientModuleUrl,
    cache,
    wantsData,
    applyBufferedCookie,
  } = options;

  const rendered = await renderPageFailure({
    name,
    path: request.path,
    request,
    response,
    thrown,
    loadErrorPage,
    routeTranslations,
    getRouteTranslations,
    appFile,
    errorPageFile,
    stylesheetUrls,
    hydrationClientModuleUrl,
  });

  applyCommit(response, rendered, applyBufferedCookie);

  // Same rule as the ordinary path (`pageVaryHeader` in
  // `create-page-route-handler.ts`): the JSON representation always gets
  // `x-warlock-data`; the HTML representation gets it only when this route
  // opted into `cache`. An error page never defers, so `User-Agent` never
  // applies here.
  const errorVaryHeader = pageVaryHeader({
    dataRepresentation: wantsData,
    cacheOptedIn: cache !== undefined,
    deferred: false,
  });

  if (errorVaryHeader !== undefined) {
    response.header("Vary", errorVaryHeader);
  }

  if (wantsData) {
    response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
    await response.send(stringify(buildHydrationPayload(rendered.bundle!, request.locale)), 500);
    return;
  }

  // `renderPageFailure` renders stylesheets and (when hydratable, which this
  // path never is) the hydration module through React already — see that
  // function. Nothing left to splice here either.
  await response.html(rendered.html, 500);
}
