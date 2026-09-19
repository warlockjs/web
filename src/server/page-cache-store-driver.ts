/**
 * The page cache's own `@warlock.js/cache` driver instance — the app's
 * configured default driver class and options, with `globalPrefix` removed.
 *
 * The app's shared driver always applies its `globalPrefix`
 * (`cache/src/utils.ts`'s `parseCacheKey`), and apps commonly make it
 * request-dependent. Through that driver, a GET without an Origin and the
 * invalidating POST with one resolve the page cache's entries and tag index
 * under two different prefixes, and a background job with no request in
 * scope has no prefix to resolve at all. `cache.namespace()` and the
 * per-call `namespace` option are applied AHEAD of `globalPrefix`, not
 * instead of it, so neither is enough; mutating the shared driver's options
 * per request races. A separate instance, built once, sidesteps all three.
 *
 * `globalPrefix` is dropped rather than pinned to a constant:
 * `TaggedCache.invalidate()` passes the already-prefixed keys from its index
 * back into `driver.remove()`, which prefixes them a second time — with any
 * `globalPrefix` set, invalidation drops the index but never the entries.
 * The fixed namespace lives in the keys and tags themselves instead
 * (`page-cache-namespace.ts`), with its deployment segment resolved once per
 * instance (`page-cache-deployment.ts`).
 *
 * Lifecycle: exactly one instance per process at a time, never one per
 * request. A replaced instance (the app switched drivers) is disconnected.
 *
 * ── WHY THIS LIVES ON `globalThis` AND NOT IN A MODULE BINDING ───────────────
 *
 * A plain module-level `let` does not work in dev, for the same reason
 * `route-table.ts` documents at length and measured first: in dev the
 * process runs TWO module graphs over the same files. HTTP routes (a blog's
 * `POST /comments` calling `invalidatePageCache`) load via tsx/Node, while
 * `@warlock.js/web` itself is one of the few family packages Vite's dev SSR
 * config deliberately keeps INSIDE its own SSR module runner rather than
 * externalising (`dev-server-config.ts`'s `WARLOCK_FAMILY_INLINE_PACKAGES`,
 * needed there for `<Head/>`'s document context) — its own registry, its own
 * instance of this module. A module-level `let state` is therefore two
 * different bindings: the HTTP route's `invalidatePageCache()` resolves one
 * driver instance, the page renderer's `getPageCacheEntry()` resolves
 * another. For the in-process memory driver that is two different heaps, so
 * the invalidating write never reaches the entry the render stored — the
 * page keeps answering a page-cache HIT after the app evicted it. (Any
 * shared out-of-process backend — redis, pg — does not have this gap: both
 * graphs' clones point at the same external store.)
 *
 * `@warlock.js/cache` itself is NOT duplicated this way — it is deliberately
 * externalised from Vite's SSR graph instead (`dev-server-config.ts`'s
 * `WEB_OPTIONAL_PEERS`), specifically so `cache.currentDriver` stays the
 * SAME object in both graphs and the `source` identity check below stays
 * meaningful. Only the CLONE this module builds from it — and memoises —
 * needs to move.
 *
 * `Symbol.for` resolves through the per-ISOLATE symbol registry, which both
 * graphs share because they are the same isolate, so there is one state no
 * matter which graph reaches it first.
 */
import type { CacheDriver, DriverClass } from "@warlock.js/cache";

import { resolvePageCacheDeployment } from "./page-cache-deployment";
import { loadPageCacheDriver } from "./page-cache-driver";
import { composePageCacheNamespace } from "./page-cache-namespace";

/** The page cache's driver instance, and the namespace every key and tag goes under. */
export type PageCacheStore = {
  driver: CacheDriver<any, any>;
  namespace: string;
};

type PageCacheStoreState = {
  /** The app driver this instance was cloned from — a switch rebuilds it. */
  source: CacheDriver<any, any>;
  store: Promise<PageCacheStore>;
};

const PAGE_CACHE_STORE_SLOT = Symbol.for("warlock.web.pageCacheStore");

type PageCacheStoreHost = typeof globalThis & {
  [PAGE_CACHE_STORE_SLOT]?: PageCacheStoreState;
};

function readState(): PageCacheStoreState | undefined {
  return (globalThis as PageCacheStoreHost)[PAGE_CACHE_STORE_SLOT];
}

function writeState(next: PageCacheStoreState | undefined): void {
  (globalThis as PageCacheStoreHost)[PAGE_CACHE_STORE_SLOT] = next;
}

/**
 * Returns the page cache's driver instance and namespace, building them on
 * first use and memoising them per process — so lookup, store and
 * `invalidatePageCache` all hit the SAME instance (for the memory driver, the
 * same heap), across BOTH dev module graphs, not just within one of them.
 * Rebuilt only when the app's current driver itself changes (`cache.use()`).
 */
export async function resolvePageCacheStoreDriver(): Promise<PageCacheStore> {
  const { cache } = await loadPageCacheDriver();
  const source = cache.currentDriver;

  if (source === undefined) {
    throw new Error(
      "[warlock:web] route.cache.serverCache needs an initialised @warlock.js/cache driver, but " +
        "the cache manager has none. Configure a default cache driver for the application.",
    );
  }

  const state = readState();

  if (state?.source !== source) {
    const previous = state;
    const store = createPageCacheStore(source).catch((cause: unknown) => {
      // Forget a failed build so the next request retries instead of
      // replaying the same rejected promise forever.
      if (readState()?.store === store) writeState(undefined);

      throw cause;
    });

    writeState({ source, store });

    // The superseded instance holds its own connection/timers — release them.
    previous?.store.then((stale) => stale.driver.disconnect()).catch(() => {});
  }

  return readState()!.store;
}

/**
 * Test-only: drops the memoised store/driver instance, mirroring
 * `route-table.ts`'s `resetRouteTable()`. The slot is process-global, so a
 * suite that built one would otherwise leak it into every later test in the
 * same worker.
 */
export function resetPageCacheStoreStateForTests(): void {
  writeState(undefined);
}

/**
 * A fresh instance of `source`'s own class, with `source`'s options minus
 * `globalPrefix`. Connection-bearing options carry over as-is: pg's
 * caller-owned `client` pool is shared, redis opens one extra client from
 * the same url/host. The namespace is resolved first, so a missing
 * deployment identity fails before any connection is opened.
 */
async function createPageCacheStore(source: CacheDriver<any, any>): Promise<PageCacheStore> {
  const namespace = composePageCacheNamespace(
    resolvePageCacheDeployment(source.name, source.options?.globalPrefix),
  );

  const Driver = source.constructor as DriverClass;
  const driver = new Driver();

  driver.setOptions({ ...source.options, globalPrefix: undefined });

  await driver.connect();

  return { driver, namespace };
}
