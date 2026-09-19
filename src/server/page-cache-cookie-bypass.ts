/**
 * The general Cookie-header bypass for the server-side page cache — SECURITY
 * FIX, card ad861076 (5.17). Kept separate from `page-cache-eligibility.ts`'s
 * `looksAuthenticated` (the `Authorization` header / configured
 * `auth.cookie.name` check) rather than folded into it: that check depends on
 * `auth.cookie.name` and only recognizes ONE cookie name, while this one
 * depends on nothing configurable and recognizes every cookie name except the
 * framework's own locale cookie. `create-page-route-handler.ts` ORs the two
 * together at its one call site — neither predicate alone is the full
 * bypass rule any more.
 *
 * The bug this closes: an app whose session cookie is named something other
 * than `auth.cookie.name` (e.g. `token`) was invisible to `looksAuthenticated`.
 * A signed-in visitor's render got STORED as if they were a guest, and the
 * next anonymous visitor's request HIT that entry — served the admin's page.
 * `auth.cookie.name` can never enumerate every cookie an application or a
 * browser extension might attach, so this predicate does not try to
 * recognize credentials at all: it treats ANY cookie other than the locale
 * cookie as a reason to bypass, unconditionally.
 */
import type { CredentialReadableRequest } from "./page-cache-eligibility";

/**
 * The cookie name `Response.setLocale()`/`request.locale` share
 * (`@warlock.js/core`'s `LOCALE_COOKIE_NAME`, `core/src/config/locale-configuration.ts`).
 * `web` cannot import it — core's public `index.ts` never re-exports it, the
 * same gap `auth-cookie-name.ts` documents for `auth.cookie.name` — so this
 * is the literal value core hardcodes, agreed by convention rather than by
 * import. It is a framework-owned constant, never a value an application
 * configures, so unlike `resolveAuthCookieName()` there is nothing to read
 * from config here.
 */
export const LOCALE_COOKIE_NAME = "locale";

/**
 * Strictly parses a raw `Cookie` request header into a name→value map, or
 * `undefined` when the header does not parse cleanly. Deliberately NOT
 * `@fastify/cookie`'s parser (or any helper that silently drops malformed
 * pairs and returns whatever it could salvage): a header this function
 * cannot fully account for must read as "unknown cookies present", not as
 * "the pairs we understood, minus the ones we didn't" — dropping a pair is
 * how a malformed header could otherwise be misread as cookie-free and
 * wrongly stay cacheable.
 *
 * Fails (`undefined`) on:
 * - an empty or whitespace-only header (`"Cookie: "`);
 * - any empty segment between/around `;` (`"Cookie: ;;;"`);
 * - any segment with no `=`, or an empty name (`"Cookie: garbage-no-equals"`).
 */
export function parseCookieHeaderStrict(rawHeader: string): Map<string, string> | undefined {
  if (rawHeader.trim() === "") return undefined;

  const cookies = new Map<string, string>();

  for (const segment of rawHeader.split(";")) {
    const pair = segment.trim();

    if (pair === "") return undefined;

    const separatorIndex = pair.indexOf("=");

    if (separatorIndex <= 0) return undefined;

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();

    if (name === "") return undefined;

    cookies.set(name, value);
  }

  return cookies;
}

/**
 * Whether the incoming request carries a cookie the page cache must treat as
 * disqualifying — lead ruling 1/2/3 (card ad861076): at the pre-lookup seam,
 * before cache lookup and before loaders, ANY `Cookie` header other than one
 * that parses cleanly to nothing but the locale cookie forces a bypass.
 *
 * - No `Cookie` header at all ⇒ `false` (the ordinary anonymous case; nothing
 *   to bypass on cookie grounds).
 * - A header that fails to parse cleanly (`parseCookieHeaderStrict` returns
 *   `undefined`) ⇒ `true` — fails CLOSED, per lead ruling 2.
 * - A header whose parsed cookie names are a non-empty set equal to exactly
 *   `{locale}` ⇒ `false` — the ONE exemption, because the locale is already
 *   part of the cache key.
 * - Anything else (any other cookie name present, alone or alongside the
 *   locale cookie) ⇒ `true`.
 *
 * Deliberately independent of `auth.cookie.name` and of a route's
 * `cache.varyBy` (lead ruling 3/5): neither can narrow this bypass.
 */
export function hasCookieRequiringPageCacheBypass(request: CredentialReadableRequest): boolean {
  const rawCookieHeader = request.header("cookie", undefined);

  // Only an ABSENT header is cookie-free. A present header in any other
  // shape (an array from a duplicated Cookie header, an object) can't be
  // accounted for, so it fails closed like a malformed string.
  if (rawCookieHeader === undefined || rawCookieHeader === null) return false;

  if (typeof rawCookieHeader !== "string") return true;

  const cookies = parseCookieHeaderStrict(rawCookieHeader);

  if (cookies === undefined || cookies.size === 0) return true;

  for (const name of cookies.keys()) {
    if (name !== LOCALE_COOKIE_NAME) return true;
  }

  return false;
}
