import { namespacePageCacheTags } from "./page-cache-namespace";
import { resolvePageCacheStoreDriver } from "./page-cache-store-driver";

/**
 * Evicts every server-side page cache entry stored under any of `tags` —
 * the public API for `route.cache.tags`'s invalidation half
 * (`../routing/route-identity.ts`'s {@link PageCacheOptIn}).
 *
 * Request-independent: the page cache's entries and tag index live under a
 * fixed namespace on its own driver instance (`page-cache-store-driver.ts`),
 * never the app's request-scoped `globalPrefix` — so a POST with a different
 * Origin than the GET that stored the page, or a queue job/CLI with no
 * request in scope at all, reaches the same entries.
 *
 * Cluster reach depends entirely on the configured `@warlock.js/cache`
 * driver: a shared driver (redis/pg) removes the entry for every worker on
 * their next read, since they already share the one external store. An
 * in-process driver (memory/LRU/memory-extended) only affects the calling
 * worker's own heap — see `page-cache-driver.ts`'s one-time startup warning.
 * Cross-process pub/sub is out of scope for this release.
 */
export async function invalidatePageCache(tags: string[]): Promise<void> {
  const { driver, namespace } = await resolvePageCacheStoreDriver();

  await driver.tags(namespacePageCacheTags(namespace, tags)).invalidate();
}
