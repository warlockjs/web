/**
 * The deployment segment of the page cache namespace
 * (`page-cache-namespace.ts`) — what keeps two deployments that share one
 * redis/pg/file backend (staging and production, say) from reading or
 * invalidating each other's pages. `APP_NAME` and the Host header can't do
 * that: both are commonly identical across such deployments.
 *
 * Resolved once per page-cache driver instance (`page-cache-store-driver.ts`),
 * in this order:
 * 1. `pageCache.namespace` — an explicit, stable, deployment-owned string.
 * 2. The app driver's `globalPrefix`, when it is a STATIC string — a
 *    configured static prefix is already deployment-owned, so it is preserved.
 * 3. None — fine for an in-process driver (memory/LRU/memory-extended), whose
 *    heap no other deployment can see; refused for a shared backend.
 */
import { config } from "@warlock.js/core";

import { isInProcessCacheDriver } from "./page-cache-driver";

/**
 * Raised at first page-cache use when `pageCache.namespace` is set to
 * anything other than a non-empty string.
 */
export class InvalidPageCacheNamespaceError extends Error {
  public constructor(value: unknown) {
    super(`"pageCache.namespace" must be a non-empty string, received ${JSON.stringify(value)}.`);
    this.name = "InvalidPageCacheNamespaceError";
  }
}

/**
 * Raised at first page-cache use on a shared backend with no stable
 * deployment identity — named explicitly, per this package's `[warlock:web]`
 * convention, so a misconfigured deployment fails loudly instead of sharing
 * (and cross-invalidating) pages with every other deployment on that backend.
 */
export class PageCacheNamespaceRequiredError extends Error {
  public constructor(driverName: string | undefined) {
    super(
      `[warlock:web] route.cache.serverCache is enabled on the shared "${driverName}" cache ` +
        'driver, but no stable deployment namespace is configured. Set "pageCache.namespace" ' +
        '(e.g. "production" or "staging") to a value unique to this deployment. The cache ' +
        "driver's globalPrefix can't stand in for it here: a function or request-derived " +
        "globalPrefix changes per request, so it can't identify a deployment on a shared backend.",
    );
    this.name = "PageCacheNamespaceRequiredError";
  }
}

/**
 * Resolves the deployment segment for a page-cache driver cloned from the
 * app driver named `driverName` with `globalPrefix` as its configured prefix.
 * Returns `undefined` when an in-process driver needs none.
 */
export function resolvePageCacheDeployment(
  driverName: string | undefined,
  globalPrefix: unknown,
): string | undefined {
  const configured = config.key<unknown>("pageCache.namespace");

  // `config.key` answers an unset key with `null`.
  if (configured !== undefined && configured !== null) {
    if (typeof configured !== "string" || configured.trim() === "") {
      throw new InvalidPageCacheNamespaceError(configured);
    }

    return configured;
  }

  if (typeof globalPrefix === "string" && globalPrefix !== "") {
    return globalPrefix;
  }

  if (isInProcessCacheDriver(driverName)) return undefined;

  throw new PageCacheNamespaceRequiredError(driverName);
}
