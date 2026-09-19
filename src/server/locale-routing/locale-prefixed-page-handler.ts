/**
 * Wraps a page's ordinary handler for one prefixed registration
 * (`/ar/posts`), pinning `request.locale` to the path's own code BEFORE
 * delegating — design note §A.2: "the handler for a prefixed registration
 * sets the locale from the path... before cache lookup and loaders. The path
 * locale outranks `?locale=`, the cookie and the header."
 *
 * The wrap happens at ROUTER-REGISTRATION level, one layer above
 * `createPageRouteHandler`'s own pipeline, so `request.locale` is already
 * pinned by the time that pipeline does its cache lookup — wrapping inside
 * the pipeline would be too late. Shared by both installers so dev and
 * production pin the locale identically.
 */
import type { HttpContext } from "@warlock.js/core";
import type { PageRouteHandler } from "../create-page-route-handler";

/**
 * Returns a handler that sets `request.locale = code` (validated through
 * core's `cacheLocale`, `core/src/http/request.ts`) and then calls
 * `pageHandler` with the same context.
 */
export function localePrefixedPageHandler(
  pageHandler: PageRouteHandler,
  code: string,
): PageRouteHandler {
  return (context: HttpContext) => {
    context.request.locale = code;

    return pageHandler(context);
  };
}
