import { type Response } from "@warlock.js/core";

/**
 * The `Set-Cookie` floor: any page response that carries a `Set-Cookie`
 * header MUST emit `Cache-Control: private, no-store`, absolutely — a future
 * per-route `cache: { public: true, maxAge: n }` opt-in cannot be allowed to
 * override it. The reason is session fixation: a `Set-Cookie` response held
 * in a shared cache hands the SAME cookie to every later visitor, not just
 * the one who received it first.
 *
 * A `Set-Cookie` can reach a page response through several forms. Checking
 * the LIVE outgoing header at the `create-page-route-handler.ts` seam — after
 * `applyCommit` and before the document/data split — covers forms 1-4 with
 * ONE check, because by that point anything that intended to set a cookie
 * has already written it to the response:
 *
 * 1. `rendered.cookies`, replayed by `applyCommit` via `applyBufferedCookie`
 *    → `response.cookie()` → `baseResponse.setCookie`.
 * 2. `rendered.headers` carrying a literal `set-cookie` key, applied by
 *    `response.headers(...)`.
 * 3. A cookie set on the LIVE response by middleware/auth BEFORE the handler
 *    runs (e.g. a token refresh) — never passes through `applyCommit` at all.
 * 4. `response.clearCookie()` — a deletion is still a `Set-Cookie`.
 *
 * Forms 1 and 4 route through `@fastify/cookie@10.0.1`'s `setCookie`/
 * `clearCookie`, which do NOT write the header synchronously — they park the
 * cookie and it is flushed onto the real `Set-Cookie` header only inside the
 * COOKIE PLUGIN'S OWN `onSend` hook (measured under NODE_ENV=production,
 * test and development: `getHeader("set-cookie")` is `undefined` immediately
 * after `setCookie()`). This seam therefore cannot observe forms 1 and 4 —
 * `set-cookie-cache-floor-hook.ts` covers those, with a SECOND `onSend` hook
 * registered to run after the cookie plugin's, where the header genuinely
 * exists. It reuses `carriesSetCookie` below against the Fastify `reply`
 * rather than duplicating the check.
 */

/**
 * Anything that can answer "does this outgoing response currently carry a
 * `Set-Cookie` header" — core's `Response` and a raw Fastify `reply` both
 * satisfy this structurally, which is what lets `carriesSetCookie` serve both
 * the `create-page-route-handler.ts` seam and the `onSend` hook in
 * `set-cookie-cache-floor-hook.ts` without a second implementation to drift
 * from.
 */
export interface HeaderReadable {
  getHeader?(key: string): unknown;
}

/**
 * Whether the LIVE outgoing response currently carries a `Set-Cookie` header.
 *
 * Reads `response.getHeader("set-cookie")` directly rather than any buffered
 * or replayed representation, so it observes forms 1-4 above uniformly.
 * Several existing unit tests hand the page route handler a plain
 * `{ path, header }` mock with no `getHeader` at all — that is treated as
 * "cannot observe", i.e. no cookie, the same way `request.locals?.authDerived`
 * treats a missing `locals` as "never touched auth state".
 */
export function carriesSetCookie(response: HeaderReadable): boolean {
  if (typeof response.getHeader !== "function") return false;

  const setCookieHeader = response.getHeader("set-cookie");

  if (Array.isArray(setCookieHeader)) return setCookieHeader.length > 0;

  return typeof setCookieHeader === "string" && setCookieHeader.length > 0;
}

/**
 * Apply the absolute `private, no-store` floor when either the request was
 * auth-derived or the response carries a `Set-Cookie`. Both reasons collapse
 * to the same header on purpose: whichever one is true, the response is not
 * safe for a shared cache to hold.
 */
export function applyResponseCacheFloor(
  response: Response,
  options: { authDerived: boolean },
): void {
  if (options.authDerived || carriesSetCookie(response)) {
    response.header("Cache-Control", "private, no-store");
  }
}
