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
 * Whether a `@warlock.js/cache` driver (by its `name`) keeps entries in this
 * process's own heap. Everything else (redis, pg, file, a custom driver) is
 * treated as a shared/out-of-process backend other processes can see.
 */
export function isInProcessCacheDriver(driverName: string | undefined): boolean {
  return driverName !== undefined && IN_PROCESS_DRIVER_NAMES.has(driverName);
}

/**
 * Raised when a route declares `serverCache: true` but `@warlock.js/cache`
 * cannot be loaded — names the package explicitly rather than surfacing a
 * bare "Cannot find module" error, per the lead decision to fail loudly.
 */
class PageCacheDependencyMissingError extends Error {
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

/**
 * ── WHY THESE LIVE ON `globalThis` AND NOT IN MODULE BINDINGS ────────────────
 *
 * Same mechanism as `page-cache-store-driver.ts`'s slot (see its comment for
 * the full account): dev runs `@warlock.js/web` as two separate module-graph
 * instances (tsx/Node for HTTP routes and installers, Vite's SSR runner for
 * the render path), so a module-level `let` here is two different bindings.
 * `@warlock.js/cache` itself is externalised from Vite's SSR graph and so is
 * NOT duplicated — both graphs' `await import("@warlock.js/cache")` resolve
 * the same Node module — but memoising the PROMISE and the warn-once flag in
 * a module binding still means each graph does its own import and prints its
 * own copy of the one-time in-process-driver warning. Moving them to the
 * shared slot makes the memoisation and the warning actually process-wide,
 * matching their doc comments below.
 */
const PAGE_CACHE_DRIVER_MODULE_SLOT = Symbol.for("warlock.web.pageCacheDriverModule");

type PageCacheDriverModuleState = {
  cacheModulePromise: Promise<typeof import("@warlock.js/cache")> | undefined;
  warnedAboutInProcessDriver: boolean;
};

type PageCacheDriverModuleHost = typeof globalThis & {
  [PAGE_CACHE_DRIVER_MODULE_SLOT]?: PageCacheDriverModuleState;
};

function driverModuleState(): PageCacheDriverModuleState {
  const host = globalThis as PageCacheDriverModuleHost;

  return (host[PAGE_CACHE_DRIVER_MODULE_SLOT] ??= {
    cacheModulePromise: undefined,
    warnedAboutInProcessDriver: false,
  });
}

/**
 * Lazily loads `@warlock.js/cache`, memoizing the promise so the dynamic
 * import only ever runs once per process — called the first time some route
 * with `serverCache: true` actually needs the store.
 */
export async function loadPageCacheDriver(): Promise<typeof import("@warlock.js/cache")> {
  const state = driverModuleState();

  if (state.cacheModulePromise === undefined) {
    state.cacheModulePromise = import("@warlock.js/cache").catch((cause: unknown) => {
      // Reset so a later call (a different process state, a retried boot) can
      // try again instead of replaying the same rejected promise forever.
      state.cacheModulePromise = undefined;
      throw new PageCacheDependencyMissingError(cause);
    });
  }

  const cacheModule = await state.cacheModulePromise;

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
  const state = driverModuleState();

  if (state.warnedAboutInProcessDriver) return;

  const driverName = cacheModule.cache.currentDriver?.name;

  if (driverName === undefined || !isInProcessCacheDriver(driverName)) return;

  state.warnedAboutInProcessDriver = true;

  console.warn(
    `[warlock:web] route.cache.serverCache is enabled with the "${driverName}" cache driver, which ` +
      "is per-process. invalidatePageCache() on one cluster worker will not reach any other " +
      "worker — each keeps serving its own stale entry until ttl/maxAge expires. Use a shared " +
      "driver (redis or pg) in a clustered deployment.",
  );
}

/** Test-only: resets the memoized module promise and warning flag between spec files. */
export function resetPageCacheDriverStateForTests(): void {
  const state = driverModuleState();

  state.cacheModulePromise = undefined;
  state.warnedAboutInProcessDriver = false;
}
