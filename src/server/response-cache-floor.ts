import { type Response } from "@warlock.js/core";
import type { PageCacheOptIn } from "../routing/route-identity";

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
 * Decide and apply the FINAL `Cache-Control` for a page response — the one
 * call site both the document and the data representation (`x-warlock-data`)
 * go through, so the two can never disagree (`create-page-route-handler.ts`).
 *
 * `authDerived` is TRI-STATE in effect, not a plain boolean, because the ruling
 * for the per-route cache opt-in is fail-CLOSED: within an opted-in route,
 * unproven means revoked.
 *
 * - `true`  — the auth mark mechanism is observable AND it fired: this request
 *   touched auth state.
 * - `false` — the auth mark mechanism is observable AND it did NOT fire: this
 *   request PROVABLY never touched auth state.
 * - `undefined` — the auth mark mechanism is not observable on this request AT
 *   ALL (`request.locals` itself is absent — see `create-page-route-handler.ts`).
 *   This is neither of the two states above: "we could not look" is not "we
 *   looked and it was clean". Treating an unobservable mark as `false` would
 *   let an opted-in route emit `public, max-age=N` for a request that might
 *   have carried auth state we simply had no way to see — an incomplete
 *   enumeration must fail toward LESS caching, never toward leaking. So only
 *   `false` — provably-not-touched — may let an opt-in take effect; `undefined`
 *   revokes it, the same as `true` would, just without the stronger `private`
 *   claim `true` is entitled to make.
 *
 * Precedence, highest wins:
 *
 * 1. `authDerived === true` or a `Set-Cookie` on the response ⇒
 *    `private, no-store`, ALWAYS — this floor beats an explicit `cache`
 *    opt-in on purpose. A `Set-Cookie` held in a shared cache hands the SAME
 *    cookie to every later visitor (session fixation); an auth-derived page
 *    is per-visitor by definition. Neither is safe for a shared cache under
 *    any opt-in.
 * 2. A route that declared `cache: { public: true, maxAge }`
 *    ({@link PageCacheOptIn}, `../routing/route-identity.ts`) AND whose
 *    `authDerived` is `false` (provably not touched, not merely unobserved)
 *    ⇒ `public, max-age=<maxAge>`.
 * 3. Everything else ⇒ `no-store` — the framework's closed-by-default answer.
 *    This is also where an opted-in route lands when `authDerived` is
 *    `undefined`: the opt-in is revoked, not honoured and not upgraded to
 *    `private` — plain `no-store` is what a route with no opt-in at all
 *    already gets, and an unobservable mark must not read as worse than
 *    that. A page that never opts in is never held by a shared cache, no
 *    matter what a loader's own committed headers said; only the two
 *    mechanisms above can produce anything other than `no-store`.
 */
export function applyResponseCacheFloor(
  response: Response,
  options: { authDerived: boolean | undefined; cache?: PageCacheOptIn },
): void {
  if (options.authDerived === true || carriesSetCookie(response)) {
    response.header("Cache-Control", "private, no-store");
    return;
  }

  if (options.cache !== undefined && options.authDerived === false) {
    response.header("Cache-Control", `public, max-age=${options.cache.maxAge}`);
    return;
  }

  response.header("Cache-Control", "no-store");
}
