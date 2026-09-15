/**
 * The ONLY place this package reaches into `@warlock.js/cache` — a lazy,
 * memoized `await import(...)`, never a static top-level import, so an
 * application that never enables `route.cache.serverCache` on any route is
 * never forced to install `@warlock.js/cache` at all (it is an OPTIONAL peer
 * — `web/package.json`). Mirrors the same `await import(...)` + memo pattern
 * `web/src/vite/dev-server-config.ts` already uses for `vite`/
 * `@vitejs/plugin-react`.
 */

/** In-process cache drivers whose invalidation never reaches another cluster worker. */
const IN_PROCESS_DRIVER_NAMES = new Set(["memory", "lru", "memoryExtended"]);

/**
 * Raised when a route declares `serverCache: true` but `@warlock.js/cache`
 * cannot be loaded — names the package explicitly rather than surfacing a
 * bare "Cannot find module" error, per the lead decision to fail loudly.
 */
export class PageCacheDependencyMissingError extends Error {
  public constructor(cause: unknown) {
    super(
      'A route declares `route.cache.serverCache: true`, but "@warlock.js/cache" could not be ' +
        "loaded. Install it as a dependency of your application — it is an optional peer of " +
        "@warlock.js/web and is only required when a route opts into the server-side page cache.",
      { cause },
    );
    this.name = "PageCacheDependencyMissingError";
  }
}

let cacheModulePromise: Promise<typeof import("@warlock.js/cache")> | undefined;
let warnedAboutInProcessDriver = false;

/**
 * Lazily loads `@warlock.js/cache`, memoizing the promise so the dynamic
 * import only ever runs once per process — called the first time some route
 * with `serverCache: true` actually needs the store.
 */
export async function loadPageCacheDriver(): Promise<typeof import("@warlock.js/cache")> {
  if (cacheModulePromise === undefined) {
    cacheModulePromise = import("@warlock.js/cache").catch((cause: unknown) => {
      // Reset so a later call (a different process state, a retried boot) can
      // try again instead of replaying the same rejected promise forever.
      cacheModulePromise = undefined;
      throw new PageCacheDependencyMissingError(cause);
    });
  }

  const cacheModule = await cacheModulePromise;

  warnIfInProcessDriver(cacheModule);

  return cacheModule;
}

/**
 * One-time, per-process warning when `serverCache` is used with an
 * in-process driver (memory/LRU/memory-extended): each cluster worker holds
 * its own heap, so `invalidatePageCache` on one worker never reaches another
 * — they keep serving the stale entry until it naturally expires. A shared
 * driver (redis/pg) does not have this gap, so it never warns.
 */
function warnIfInProcessDriver(cacheModule: typeof import("@warlock.js/cache")): void {
  if (warnedAboutInProcessDriver) return;

  const driverName = cacheModule.cache.currentDriver?.name;

  if (driverName === undefined || !IN_PROCESS_DRIVER_NAMES.has(driverName)) return;

  warnedAboutInProcessDriver = true;

  console.warn(
    `[warlock:web] route.cache.serverCache is enabled with the "${driverName}" cache driver, which ` +
      "is per-process. invalidatePageCache() on one cluster worker will not reach any other " +
      "worker — each keeps serving its own stale entry until ttl/maxAge expires. Use a shared " +
      "driver (redis or pg) in a clustered deployment.",
  );
}

/** Test-only: resets the memoized module promise and warning flag between spec files. */
export function resetPageCacheDriverStateForTests(): void {
  cacheModulePromise = undefined;
  warnedAboutInProcessDriver = false;
}
