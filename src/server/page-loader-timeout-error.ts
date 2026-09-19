import { PublicPageError } from "./public-page-error";

/**
 * Raised when the non-deferred loader chain of ONE page request (app →
 * layout → page loaders, plus the page's own `validation` export) does not
 * settle within `web.loaderTimeout` (`streaming-config.ts`'s
 * `resolveLoaderTimeoutMs`) — card `904a04eb`, audit §5.1. Renders the app's
 * `error.page.tsx` boundary with status 504, exactly the same
 * throw-signal/boundary machinery an ordinary loader throw already takes
 * (`execute-page-request.ts`).
 *
 * Extends {@link PublicPageError} deliberately: its message is the ONLY
 * content a real visitor ever sees for this failure, in production and in
 * development alike, and it must never leak which loader hung or why —
 * `isVisitorSafePageError`/`serializePageError` already trust every
 * `PublicPageError` to carry a safe message, so this class needs no separate
 * carve-out in either of those chokepoints.
 */
export class PageLoaderTimeoutError extends PublicPageError {
  /** Always 504 — the loader chain is at fault, not the visitor's request. */
  public readonly statusCode = 504;

  public constructor(public readonly timeoutMs: number) {
    super("This page took too long to load. Please try again.");
    this.name = "PageLoaderTimeoutError";
  }
}
