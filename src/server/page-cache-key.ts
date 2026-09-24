/**
 * Pure cache-key composition for the server-side page cache
 * (`page-cache-store.ts`). Mirrors the axes the page pipeline varies a
 * response on — host, path, query, locale, representation, and a route's
 * optional `cache.varyBy` — so a
 * request that would get different bytes never shares an entry with one that
 * wouldn't, and a request that would get the SAME bytes always does.
 *
 * Deliberately dependency-free: no `fs`, no Node built-ins, no framework
 * imports — just string logic, so it is trivial to unit test and safe to call
 * from any runtime this package ends up in.
 */

/** The two representations the page cache stores. NDJSON is never a variant — see `page-cache-key.spec.ts`. */
export type PageCacheVariant = "html" | "json";

export type PageCacheKeyInput = {
  /**
   * The request `Host` header, port included. Two hosts serving the same URL
   * are two tenants until proven otherwise, and a key without the host lets a
   * render that reflects the host poison every other host's visitors.
   */
  host: string;
  /** The raw request path, query string included — `request.path`. */
  path: string;
  /** The raw request query object — `request.query`. */
  query: Record<string, unknown>;
  locale: string;
  variant: PageCacheVariant;
  /** The route's own `cache.varyBy(request)` result, when it declares one. */
  vary?: string;
  /**
   * The route's `cache.query` allowlist. When set, ONLY these query keys enter
   * the key; when absent, every key except {@link IGNORED_TRACKING_PARAMS}.
   */
  queryAllowlist?: readonly string[];
  /** Content identity of route-owned translations, absent for legacy registration. */
  translationsRevision?: string;
};

/** Tracking params that never change the rendered bytes; ignored when no allowlist is set. */
const IGNORED_TRACKING_PARAMS = /^(utm_[a-z0-9_]*|fbclid|gclid|msclkid|mc_eid|_ga)$/i;

/**
 * Normalises a pathname the same way `create-page-route-handler.ts` already
 * splits `request.path` on `"?"` — case preserved, trailing slash stripped
 * except for the root `"/"`.
 */
function normalisePathname(path: string): string {
  const [pathname = path] = path.split("?");

  // Case is KEPT: production routing is case-sensitive and params keep their
  // case, so `/users/Alice` and `/users/alice` are two different pages.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

/**
 * Sorts query keys and re-serializes them, so two requests differing only in
 * parameter order (`?a=1&b=2` vs `?b=2&a=1`) resolve to the same string.
 * Array values are serialized in their given order — only the KEYS are
 * sorted, not each value's contents.
 */
function normaliseQuery(
  query: Record<string, unknown>,
  allowlist: readonly string[] | undefined,
): string {
  const keys = Object.keys(query)
    .filter((key) =>
      allowlist === undefined ? !IGNORED_TRACKING_PARAMS.test(key) : allowlist.includes(key),
    )
    .sort();
  const params = new URLSearchParams();

  for (const key of keys) {
    const value = query[key];

    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value !== undefined) {
      params.append(key, String(value));
    }
  }

  return params.toString();
}

/**
 * Composes the server-side page cache key:
 * `host + (normalised path) + "?" + (sorted query) + "|" + locale + "|" + variant`,
 * plus `"|vary=" + varyBy` when the route declares one.
 *
 * The `variant` is decided by the CALLER from `wantsData` alone — a request
 * that asks for NDJSON on a cache-eligible route still resolves to the
 * `"json"` variant, since the values behind it are always fully resolved
 * before storage (see `create-page-route-handler.ts`).
 */
export function computePageCacheKey(input: PageCacheKeyInput): string {
  const pathname = normalisePathname(input.path);
  const query = normaliseQuery(input.query, input.queryAllowlist);

  const host = input.host.toLowerCase();
  const vary = input.vary === undefined ? "" : `|vary=${encodeURIComponent(input.vary)}`;
  const translations =
    input.translationsRevision === undefined
      ? ""
      : `|translations=${encodeURIComponent(input.translationsRevision)}`;

  // The host is URI-component encoded so no host value can forge the path
  // part of another entry's key.
  return `${encodeURIComponent(host)}${pathname}?${query}|${input.locale}|${input.variant}${vary}${translations}`;
}
