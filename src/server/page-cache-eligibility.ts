/**
 * Eligibility rules for the server-side page cache — kept separate from
 * `page-cache-store.ts` (the storage mechanics) and
 * `create-page-route-handler.ts` (the request seam) so each of the two
 * decisions this feature makes — "may we even LOOK at the cache" and "may we
 * STORE what we just rendered" — has one, independently testable home.
 */
import { carriesSetCookie, type HeaderReadable } from "./response-cache-floor";

/**
 * The minimal request surface this module needs — structural, not core's
 * `Request`, so a hand-built test double (the same shape several page-route
 * handler specs already use) satisfies it without a real Fastify request.
 */
export type CredentialReadableRequest = {
  header(name: string, defaultValue?: unknown): unknown;
  cookie(name: string, defaultValue?: unknown): unknown;
};

/**
 * Whether the INCOMING request carries a credential — an `Authorization`
 * header or the configured auth cookie. This is a cheap, pre-render signal,
 * not a verification: it exists only to decide whether the page cache is
 * even consulted, because a guest-cached page must never be handed to a
 * request that looks authenticated before request-scoped personalization has
 * had a chance to run — mirroring how `@warlock.js/auth`'s own middleware
 * reads the raw candidate before ever calling `jwt.verify`.
 *
 * Read BEFORE the loader/module-load Promise.all and before any cache
 * lookup — see `create-page-route-handler.ts`.
 */
export function looksAuthenticated(
  request: CredentialReadableRequest,
  cookieName: string,
): boolean {
  return Boolean(request.header("authorization", undefined)) || Boolean(request.cookie(cookieName));
}

export type StoreEligibilityInput = {
  method: string;
  /**
   * The exact tri-state already computed for `applyResponseCacheFloor` —
   * reused, never recomputed, so the two decisions cannot read auth state
   * differently.
   */
  authDerived: boolean | undefined;
  response: HeaderReadable;
  status: number;
  /** The REAL `isCrawlerRequest` result — never the forced `crawler: true` render option. */
  crawler: boolean;
  /**
   * Whether the RENDERED page itself buffered a cookie to apply
   * (`RenderedPage.cookies`, or a literal `set-cookie` key in
   * `RenderedPage.headers`) — checked in ADDITION to the live
   * `carriesSetCookie(response)` read, because `@fastify/cookie`'s
   * `setCookie`/`clearCookie` park the header rather than writing it
   * synchronously (`response-cache-floor.ts`'s doc comment, forms 1 and 4):
   * at THIS seam, immediately after `applyCommit`, the live header can still
   * read as absent even though a cookie is about to be flushed by the
   * cookie plugin's own later `onSend` hook. Reading the buffered value
   * directly closes that gap without needing a second, later check.
   */
  hasBufferedCookie: boolean;
};

/**
 * Whether a just-rendered response may be written to the server-side page
 * cache. Fails closed: every condition must hold.
 *
 * - `GET` only — a mutating method is never cached.
 * - `authDerived === false`, exactly — `true` (touched) and `undefined`
 *   (unobservable) both refuse storage, the same fail-closed rule
 *   `response-cache-floor.ts` already applies to `Cache-Control`.
 * - No `Set-Cookie`, buffered or already flushed onto the live response.
 * - `status === 200`.
 * - Not a real crawler request — a crawler's fully-resolved render is safe to
 *   READ from the cache, but is never itself stored: a browser must still
 *   get the streamed shell on a MISS, which a crawler-detected render never
 *   produces, so storing it under the same key would serve the wrong shape
 *   to the next ordinary visitor.
 */
export function isStoreEligible(input: StoreEligibilityInput): boolean {
  return (
    input.method === "GET" &&
    input.authDerived === false &&
    !input.hasBufferedCookie &&
    !carriesSetCookie(input.response) &&
    input.status === 200 &&
    !input.crawler
  );
}
