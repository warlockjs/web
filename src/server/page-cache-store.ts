/**
 * Get/set orchestration for the server-side page cache, on top of
 * `@warlock.js/cache`'s tag mechanism (`cache.tags(tags).set/.get/.invalidate`
 * — `cache/src/tagged-cache.ts`). `@warlock.js/cache` itself is reached only
 * through `page-cache-driver.ts`'s lazy loader — this module never imports it
 * statically.
 */
import { loadPageCacheDriver } from "./page-cache-driver";

/** What a stored entry holds — enough to replay a HIT without re-rendering. */
export type StoredPageCacheEntry = {
  /** The response body — the full HTML document, or the devalue JSON string. */
  body: string;
  status: number;
  contentType: string;
  /** Whether the page called `defer()`, replayed as `Vary: User-Agent` on a HIT. */
  usesDefer: boolean;
};

/**
 * Reads a stored entry. Returns `undefined` on a miss — `@warlock.js/cache`
 * itself answers a miss with `null`, normalised here so callers only ever
 * deal with `undefined`.
 */
export async function getPageCacheEntry(key: string): Promise<StoredPageCacheEntry | undefined> {
  const { cache } = await loadPageCacheDriver();
  const value = await cache.get<StoredPageCacheEntry>(key);

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
  const { cache } = await loadPageCacheDriver();

  await cache.tags(tags).set(key, entry, ttl);
}
