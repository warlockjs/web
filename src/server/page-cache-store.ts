/**
 * Get/set orchestration for the server-side page cache, on top of
 * `@warlock.js/cache`'s tag mechanism (`driver.tags(tags).set/.get/.invalidate`
 * — `cache/src/tagged-cache.ts`). `@warlock.js/cache` itself is reached only
 * through `page-cache-driver.ts`'s lazy loader — this module never imports it
 * statically.
 *
 * Every read and write goes through the page cache's own driver instance
 * (`page-cache-store-driver.ts`) under its fixed namespace
 * (`page-cache-namespace.ts`), never the app's request-scoped `globalPrefix`.
 */
import { namespacePageCacheKey, namespacePageCacheTags } from "./page-cache-namespace";
import { resolvePageCacheStoreDriver } from "./page-cache-store-driver";

/** What a stored entry holds — enough to replay a HIT without re-rendering. */
export type StoredPageCacheEntry = {
  /** The response body — the full HTML document, or the devalue JSON string. */
  body: string;
  status: number;
  contentType: string;
  /** Whether the page called `defer()`, replayed as `Vary: User-Agent` on a HIT. */
  usesDefer: boolean;
  /**
   * Non-cookie headers the MISS committed (`X-Robots-Tag`, `Link`,
   * `Content-Language`, custom ones), replayed on a HIT. Absent on entries
   * written before this field existed.
   */
  headers?: Record<string, string>;
};

/**
 * Reads a stored entry. Returns `undefined` on a miss — `@warlock.js/cache`
 * itself answers a miss with `null`, normalised here so callers only ever
 * deal with `undefined`.
 */
export async function getPageCacheEntry(key: string): Promise<StoredPageCacheEntry | undefined> {
  const { driver, namespace } = await resolvePageCacheStoreDriver();
  const value = await driver.get<StoredPageCacheEntry>(namespacePageCacheKey(namespace, key));

  return value ?? undefined;
}

/**
 * Writes an entry under the given tags, so `invalidatePageCache(tags)` can
 * evict it early. `ttl` is in seconds, matching `PageCacheOptIn.ttl`/`maxAge`.
 */
export async function setPageCacheEntry(
  key: string,
  entry: StoredPageCacheEntry,
  ttl: number,
  tags: string[],
): Promise<void> {
  const { driver, namespace } = await resolvePageCacheStoreDriver();

  await driver
    .tags(namespacePageCacheTags(namespace, tags))
    .set(namespacePageCacheKey(namespace, key), entry, ttl);
}
