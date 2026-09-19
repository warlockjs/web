/**
 * THE not-found route's handler options both page installers build alike —
 * dev's `./install-page-routes.ts` and production's
 * `./install-page-routes-from-manifest.ts` — for the application's OWN
 * `404.page.tsx`, once one exists to register.
 *
 * WHAT IS IDENTICAL, and lives here: no layout (see the two installers' own
 * comments for why a guard-bearing chain must never run on the miss path),
 * the catch-all's `matchPath` trick (`requestPath => requestPath`, so `*`
 * matches the URL that actually missed), the `404` override for a settled
 * `200`, `skipPageLoader` (a miss must not run application data work), and
 * `noindex` (a 404 document is never indexable).
 *
 * WHAT STAYS WITH EACH CALLER, because it is the one thing that legitimately
 * differs between the two installers and losing that seam would blur what
 * they mean:
 *
 *  - `loadModule` — dev hands over `vite.ssrLoadModule`; production a lookup
 *    over its already-built manifest.
 *  - `stylesheetUrls` — dev walks Vite's LIVE module graph
 *    (`devHandlerStylesheetUrls`); production reads the built client
 *    manifest (`productionStylesheetUrls`). Each caller resolves its own
 *    list and hands the already-computed array in, so the two readings never
 *    have to agree on HOW to resolve CSS, only that this table has a slot
 *    for the result.
 *  - `httpServer` — dev's `InstallPageRoutesOptions` carries an optional
 *    Fastify instance forwarded when supplied; production's manifest
 *    installer has no such field at all and always falls back to the
 *    container. Left OUT of this table for exactly that reason: a field one
 *    caller has and the other does not is not a shared responsibility to
 *    unify, so dev spreads it on top of this table's return value instead.
 */
import type { PageModuleLoader, PageRouteHandlerOptions } from "./create-page-route-handler";
import type { ErrorPageModuleLoader } from "./error-page";
import type { RequestStylesheetUrlResolver } from "./document-stylesheet-urls";
import { NOT_FOUND_ROUTE_NAME, NOT_FOUND_ROUTE_PATH } from "./not-found-page";

export type NotFoundPageHandlerInput = {
  /** The single global app-root file/source-id. */
  appFile: string;
  /** The application's own `404.page.tsx` file/source-id. */
  pageFile: string;
  loadModule: PageModuleLoader;
  hydrationClientModuleUrl?: string;
  loadErrorPage?: ErrorPageModuleLoader;
  /** Already resolved by the caller — see this module's header for why. */
  stylesheetUrls: readonly string[];
  /** Resolves per-request `linkStylesheetsFor()` declarations; see `PageRouteHandlerOptions`. */
  resolveRequestStylesheetUrls?: RequestStylesheetUrlResolver;
};

/**
 * Builds the not-found route's handler options minus `httpServer`, which
 * only dev ever has to offer — see this module's header.
 */
export function notFoundPageHandlerOptions(
  input: NotFoundPageHandlerInput,
): Omit<PageRouteHandlerOptions, "httpServer"> {
  return {
    path: NOT_FOUND_ROUTE_PATH,
    name: NOT_FOUND_ROUTE_NAME,
    appFile: input.appFile,
    pageFile: input.pageFile,
    // NO LAYOUT, deliberately — see both installers' own comments: a guard
    // that redirects or throws on the not-found path turns a missing page
    // into an incident.
    layoutFile: undefined,
    loadModule: input.loadModule,
    hydrationClientModuleUrl: input.hydrationClientModuleUrl,
    loadErrorPage: input.loadErrorPage,
    // NO LAYOUT means no layout CSS either — just root and the not-found
    // page's own stylesheets.
    stylesheetUrls: input.stylesheetUrls,
    resolveRequestStylesheetUrls: input.resolveRequestStylesheetUrls,
    // The URL that missed IS this route's pattern for this request.
    matchPath: (requestPath) => requestPath,
    statusForRenderedOk: 404,
    skipPageLoader: true,
    // A 404 document is never indexable — the same `robots` answer the
    // framework fallback (`frameworkDefaultNotFoundDocument`) already gives.
    noindex: true,
  };
}
