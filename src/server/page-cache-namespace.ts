/**
 * The page cache's fixed storage namespace: `warlock.page`, plus the
 * deployment segment `page-cache-deployment.ts` resolves once
 * (`warlock.page.<deployment>`). Every entry key and every tag the page cache
 * hands `@warlock.js/cache` is prefixed with it, so its entries and tag index
 * sit at the same place for every request, every worker and every background
 * job of one deployment — never under the application's `globalPrefix`,
 * which apps commonly derive from the request (Origin, a domain header,
 * `?domain=`). `page-cache-store-driver.ts` is what keeps that
 * `globalPrefix` off the page cache's driver instance.
 *
 * The host stays a key axis inside the namespace (`page-cache-key.ts`), so
 * one namespace never lets a tenant read another tenant's page.
 */
export const PAGE_CACHE_NAMESPACE_ROOT = "warlock.page";

/** `warlock.page.<deployment>`, or just `warlock.page` when there is no deployment segment. */
export function composePageCacheNamespace(deployment: string | undefined): string {
  return deployment === undefined
    ? PAGE_CACHE_NAMESPACE_ROOT
    : `${PAGE_CACHE_NAMESPACE_ROOT}.${deployment}`;
}

/** Places a `computePageCacheKey()` key inside `namespace`. */
export function namespacePageCacheKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

/**
 * Places route `cache.tags` inside `namespace`, so the tag index
 * (`cache:tags:<tag>`, `@warlock.js/cache`'s `TaggedCache`) never shares an
 * entry with the application's own tags, or another deployment's, of the
 * same name.
 */
export function namespacePageCacheTags(namespace: string, tags: string[]): string[] {
  return tags.map((tag) => `${namespace}.${tag}`);
}
