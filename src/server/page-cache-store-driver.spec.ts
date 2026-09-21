/**
 * Pins the exact defect `page-cache-store-driver.ts`'s "WHY THIS LIVES ON
 * `globalThis`" comment describes: in dev the process runs TWO module graphs
 * over the same files (HTTP routes/installers through tsx/Node, page/layout
 * modules and the render pipeline through Vite's SSR module runner — its own
 * registry, its own instance of `@warlock.js/web`). A module-level `let`
 * store is then two different bindings, so a blog route's
 * `invalidatePageCache(["post:1"])` never reaches the entry the renderer's
 * `getPageCacheEntry` stored — the page keeps answering a HIT after the app
 * evicted it. This was reported live: in production (one module graph) the
 * same call evicts correctly.
 *
 * A unit test cannot spin up tsx and Vite's SSR runner. What it CAN do —
 * mirroring `route-table.spec.ts`'s "reachable across module graphs" suite —
 * is import the local `page-cache-store`/`invalidate-page-cache` modules
 * twice as genuinely separate instances (`vi.resetModules()` + dynamic
 * import), while keeping `@warlock.js/cache` the SAME real singleton both
 * "graphs" resolve — exactly as dev-server-config.ts's `WEB_OPTIONAL_PEERS`
 * keeps it externalised from Vite's SSR graph in reality. That isolates the
 * one variable this file's fix controls: whether the store/driver instance
 * survives being resolved through two different local module instances.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cacheModuleNamespace from "@warlock.js/cache";
import { cache, MemoryCacheDriver } from "@warlock.js/cache";

import type { StoredPageCacheEntry } from "./page-cache-store";

const entry = (body: string): StoredPageCacheEntry => {
  return { body, status: 200, contentType: "text/html", usesDefer: false };
};

/**
 * Imports a fresh instance of `path`, as a separate "module graph" would —
 * `@warlock.js/cache` is mocked back to the ONE real singleton so the two
 * graphs still agree on which app driver they cloned from, matching
 * production's externalisation rather than accidentally duplicating the
 * package too.
 */
async function importAsFreshGraph<T>(path: string): Promise<T> {
  vi.resetModules();
  vi.doMock("@warlock.js/cache", () => cacheModuleNamespace);

  return (await import(path)) as T;
}

describe("page cache store — reachable across module graphs (dev's tsx graph + Vite SSR graph)", () => {
  beforeEach(async () => {
    cache.loadedDrivers = {};
    cache.setCacheConfigurations({
      default: "memory",
      drivers: { memory: MemoryCacheDriver },
      options: { memory: {} },
    });

    await cache.init();
  });

  afterEach(async () => {
    await cache.disconnect();
    vi.resetModules();
    vi.doUnmock("@warlock.js/cache");
  });

  it("evicts, through one module-graph instance, an entry stored by another", async () => {
    // Re-transforming and re-evaluating this file's local module tree twice
    // per test (once per simulated graph) is slower than a normal unit test.
    // A serialized run measured 59.31s against the former 60s limit. Keep both
    // fresh graphs (the regression's premise) and scope headroom to this case.
    const graphA =
      await importAsFreshGraph<typeof import("./page-cache-store")>("./page-cache-store");
    const graphB =
      await importAsFreshGraph<typeof import("./invalidate-page-cache")>("./invalidate-page-cache");

    const key = "posts/1";

    // The renderer's graph stores the entry — mirrors a page render HIT-ing
    // going forward.
    await graphA.setPageCacheEntry(key, entry("<p>v1</p>"), 60, ["post:1"]);

    // A DIFFERENT module-graph instance invalidates it — mirrors the blog's
    // POST /comments route, loaded through tsx/Node, calling
    // invalidatePageCache(["post:1"]) after a new comment is saved.
    await graphB.invalidatePageCache(["post:1"]);

    // The renderer's own graph must now see a miss — a HIT here is exactly
    // the bug: "the post page stays a page-cache HIT afterwards" in dev.
    expect(await graphA.getPageCacheEntry(key)).toBeUndefined();
  }, 120_000);
});
