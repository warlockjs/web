/**
 * The `[locale]`-folder half of locale routing (design note §C): a page whose
 * effective route path's FIRST segment is the param `:locale` — from a
 * `src/web/[locale]/...` directory or an explicit `route: "/:locale/..."` —
 * is locale-routed with no `web.localeRouting` config at all.
 *
 * Mirrors `./locale-prefixed-page-handler.ts`'s own placement: the wrap
 * happens at ROUTER-REGISTRATION level, one layer above
 * `createPageRouteHandler`'s own pipeline, so `request.locale` is pinned (or
 * the request is turned into the not-found answer) BEFORE that pipeline's
 * cache lookup and loaders run. Shared by both installers through
 * `./locale-page-registrations.ts` so dev and production agree on both the
 * pin and the 404.
 */
import type { HttpContext } from "@warlock.js/core";
import { frameworkDefaultNotFoundDocument } from "../not-found-page";
import type { PageRouteHandler } from "../create-page-route-handler";

/** The literal param name a leading `:locale` segment must use. */
const LOCALE_PARAM_NAME = "locale";

/**
 * True when `path`'s FIRST segment is the param `:locale` — a bare
 * `src/web/[locale]/...` page or an explicit `/:locale/...` route. A
 * `:locale` param appearing deeper in the path (`/posts/:locale`) is an
 * ordinary param and does not count (design note §C.1's "only the first
 * segment counts").
 */
export function hasLeadingLocaleParam(path: string): boolean {
  const [firstSegment] = path.split("/").filter((segment) => segment.length > 0);

  return firstSegment === `:${LOCALE_PARAM_NAME}`;
}

/**
 * Wraps a `[locale]`-routed page's ordinary handler so that:
 *
 * - a `locale` param value in `codes` pins `request.locale` to it BEFORE
 *   delegating to `pageHandler` — the same "before cache lookup and loaders"
 *   position `./locale-prefixed-page-handler.ts` uses for card A;
 * - a value outside `codes` renders the application's own not-found answer —
 *   the same delegated path a loader `notFound()` uses
 *   (`../create-page-route-handler.ts`'s own `renderNotFound` seam), falling
 *   back to the framework default document when the application ships no
 *   `404.page.tsx`. The page handler is never called in this branch.
 */
export function localeParamPageHandler(
  pageHandler: PageRouteHandler,
  codes: readonly string[],
  renderNotFound: () => PageRouteHandler | undefined,
): PageRouteHandler {
  return async (context: HttpContext) => {
    const { request, response } = context;
    const params = request.params as Record<string, string>;
    const value = params[LOCALE_PARAM_NAME];

    if (typeof value !== "string" || !codes.includes(value)) {
      const notFoundHandler = renderNotFound();

      if (notFoundHandler !== undefined) return notFoundHandler(context);

      await response.html(frameworkDefaultNotFoundDocument(request.locale), 404);

      return;
    }

    request.locale = value;

    return pageHandler(context);
  };
}
