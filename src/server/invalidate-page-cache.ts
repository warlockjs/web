import { loadPageCacheDriver } from "./page-cache-driver";

/**
 * Evicts every server-side page cache entry stored under any of `tags` —
 * the public API for `route.cache.tags`'s invalidation half
 * (`../routing/route-identity.ts`'s {@link PageCacheOptIn}).
 *
 * Cluster reach depends entirely on the configured `@warlock.js/cache`
 * driver: a shared driver (redis/pg) removes the entry for every worker on
 * their next read, since they already share the one external store. An
 * in-process driver (memory/LRU/memory-extended) only affects the calling
 * worker's own heap — see `page-cache-driver.ts`'s one-time startup warning.
 * Cross-process pub/sub is out of scope for this release.
 */
export async function invalidatePageCache(tags: string[]): Promise<void> {
  const { cache } = await loadPageCacheDriver();

  await cache.tags(tags).invalidate();
}
