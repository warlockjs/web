/**
 * The server-side page cache's storage namespace, against the REAL
 * `@warlock.js/cache` manager and memory driver (no mock) — the layer
 * `page-server-cache.spec.ts` fakes out.
 *
 * Apps commonly make `globalPrefix` request-dependent (the scaffold keyed it
 * on the request's Origin, a domain header or a `?domain=` input). The page
 * cache's entries AND its tag index must never follow it: a browser GET
 * (no Origin) and the CSRF-protected POST that invalidates (with Origin)
 * would otherwise read and write two different namespaces, and nothing is
 * ever evicted. `requestPrefix` below stands in for that app-side function.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache, MemoryCacheDriver } from "@warlock.js/cache";
import { setConfig } from "@warlock.js/core";

import { invalidatePageCache } from "./invalidate-page-cache";
import { PageCacheNamespaceRequiredError } from "./page-cache-deployment";
import { resetPageCacheDriverStateForTests } from "./page-cache-driver";
import { computePageCacheKey } from "./page-cache-key";
import {
  getPageCacheEntry,
  setPageCacheEntry,
  type StoredPageCacheEntry,
} from "./page-cache-store";

/** What the app's `globalPrefix` function currently returns — or throws, for "no request in scope". */
let requestPrefix: () => string = () => "store";

const keyFor = (host: string, path: string): string => {
  return computePageCacheKey({ host, path, query: {}, locale: "en", variant: "html" });
};

const entry = (body: string): StoredPageCacheEntry => {
  return { body, status: 200, contentType: "text/html", usesDefer: false };
};

describe("page cache namespace (independent of the app's request-scoped globalPrefix)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    requestPrefix = () => "store";

    // A fresh manager state per test: a new memory driver instance, so no
    // entry leaks from one test into the next.
    cache.loadedDrivers = {};
    cache.setCacheConfigurations({
      default: "memory",
      drivers: { memory: MemoryCacheDriver },
      options: { memory: { globalPrefix: () => requestPrefix() } },
    });

    await cache.init();

    resetPageCacheDriverStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cache.disconnect();
  });

  it("evicts an entry stored under one request prefix when invalidated under another", async () => {
    const key = keyFor("localhost:3000", "/posts/1");

    // Anonymous browser GET — no Origin, so the app's prefix is "store".
    await setPageCacheEntry(key, entry("<p>v1</p>"), 60, ["post.1"]);

    // The comment POST carries an Origin — the app's prefix now differs.
    requestPrefix = () => "store.localhost";
    await invalidatePageCache(["post.1"]);

    // The next anonymous GET is back on "store" — and must not see v1.
    requestPrefix = () => "store";
    expect(await getPageCacheEntry(key)).toBeUndefined();
  });

  it("evicts from a background job with no request in scope (the app's prefix throws)", async () => {
    const key = keyFor("localhost:3000", "/posts/2");

    await setPageCacheEntry(key, entry("<p>v1</p>"), 60, ["post.2"]);

    requestPrefix = () => {
      throw new Error("no request in scope");
    };

    await invalidatePageCache(["post.2"]);

    requestPrefix = () => "store";
    expect(await getPageCacheEntry(key)).toBeUndefined();
  });

  it("keeps the host as a key axis: host A never reads host B's entry", async () => {
    const keyA = keyFor("a.example.com", "/posts/3");
    const keyB = keyFor("b.example.com", "/posts/3");

    expect(keyA).not.toBe(keyB);

    await setPageCacheEntry(keyA, entry("<p>tenant A</p>"), 60, ["post.3"]);
    await setPageCacheEntry(keyB, entry("<p>tenant B</p>"), 60, ["post.3"]);

    expect((await getPageCacheEntry(keyA))?.body).toBe("<p>tenant A</p>");
    expect((await getPageCacheEntry(keyB))?.body).toBe("<p>tenant B</p>");
    expect(await getPageCacheEntry(keyFor("c.example.com", "/posts/3"))).toBeUndefined();
  });

  it("ignores a visitor-controlled prefix (?domain=evil): the stored entry still HITs", async () => {
    const key = keyFor("localhost:3000", "/posts/4");

    await setPageCacheEntry(key, entry("<p>v1</p>"), 60, ["post.4"]);

    requestPrefix = () => "evil";

    expect((await getPageCacheEntry(key))?.body).toBe("<p>v1</p>");
  });

  it("evicts only the invalidated tag's entries — other tags survive", async () => {
    const invalidatedKey = keyFor("localhost:3000", "/posts/5");
    const survivingKey = keyFor("localhost:3000", "/posts/6");

    await setPageCacheEntry(invalidatedKey, entry("<p>five</p>"), 60, ["post.5"]);
    await setPageCacheEntry(survivingKey, entry("<p>six</p>"), 60, ["post.6"]);

    await invalidatePageCache(["post.5"]);

    expect(await getPageCacheEntry(invalidatedKey)).toBeUndefined();
    expect((await getPageCacheEntry(survivingKey))?.body).toBe("<p>six</p>");
  });
});

/**
 * One backend store two deployments (two processes, in production) share —
 * stands in for a redis/pg database. Every `SharedBackendDriver` instance
 * reads and writes this same object, so its `name` classifies it as a
 * shared, out-of-process backend (`page-cache-driver.ts`).
 */
const sharedBackend: Record<string, unknown> = {};

class SharedBackendDriver extends MemoryCacheDriver {
  /** Instances built so far — the app's own driver plus any page-cache clone. */
  public static instances = 0;

  public override name = "sharedBackend";

  public constructor() {
    super();
    SharedBackendDriver.instances++;
    this.data = sharedBackend;
  }
}

/**
 * Boots one "deployment": a fresh manager state on `driver`, with the given
 * `globalPrefix` and `pageCache.namespace`. A new app driver instance is what
 * makes the page cache resolve its store and namespace again, exactly as a
 * separate process would.
 */
const bootDeployment = async (options: {
  driver: typeof MemoryCacheDriver;
  globalPrefix: string | (() => string);
  namespace?: string;
}): Promise<void> => {
  // The registry key is arbitrary — the page cache classifies a driver by
  // its instance `name`, not by what it was registered as.
  const registryKey = options.driver.name;

  setConfig("pageCache.namespace", options.namespace as never);

  cache.loadedDrivers = {};
  cache.registerDriver(registryKey, options.driver);

  await cache.use(registryKey, { globalPrefix: options.globalPrefix });
};

describe("page cache deployment namespace (shared backends)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const key of Object.keys(sharedBackend)) delete sharedBackend[key];

    resetPageCacheDriverStateForTests();
  });

  afterEach(() => {
    setConfig("pageCache.namespace", undefined as never);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cache.disconnect();
  });

  it("isolates two deployments sharing one backend by pageCache.namespace, invalidation included", async () => {
    const key = keyFor("example.com", "/posts/9");
    const staging = { driver: SharedBackendDriver, globalPrefix: "", namespace: "staging" };
    const production = { driver: SharedBackendDriver, globalPrefix: "", namespace: "production" };

    await bootDeployment(staging);
    await setPageCacheEntry(key, entry("<p>staging</p>"), 60, ["post.9"]);

    await bootDeployment(production);
    expect(await getPageCacheEntry(key)).toBeUndefined();

    await setPageCacheEntry(key, entry("<p>production</p>"), 60, ["post.9"]);
    await invalidatePageCache(["post.9"]);
    expect(await getPageCacheEntry(key)).toBeUndefined();

    await bootDeployment(staging);
    expect((await getPageCacheEntry(key))?.body).toBe("<p>staging</p>");
  });

  it("preserves a static globalPrefix as the deployment segment", async () => {
    const key = keyFor("example.com", "/posts/10");

    await bootDeployment({ driver: SharedBackendDriver, globalPrefix: "acme-prod" });
    await setPageCacheEntry(key, entry("<p>prod</p>"), 60, ["post.10"]);

    expect(sharedBackend).toMatchObject({ warlock: { page: { "acme-prod": expect.any(Object) } } });

    await bootDeployment({ driver: SharedBackendDriver, globalPrefix: "acme-staging" });
    expect(await getPageCacheEntry(key)).toBeUndefined();
  });

  it("refuses a function globalPrefix on a shared backend with no pageCache.namespace", async () => {
    await bootDeployment({ driver: SharedBackendDriver, globalPrefix: () => "store" });

    const failure = setPageCacheEntry(keyFor("example.com", "/"), entry("<p>x</p>"), 60, []);

    await expect(failure).rejects.toThrow(PageCacheNamespaceRequiredError);
    await expect(invalidatePageCache(["post.11"])).rejects.toThrow(/pageCache\.namespace/);
  });

  it("accepts a function globalPrefix on the in-process memory driver with no namespace", async () => {
    const key = keyFor("example.com", "/posts/12");

    await bootDeployment({ driver: MemoryCacheDriver, globalPrefix: () => "store" });
    await setPageCacheEntry(key, entry("<p>memory</p>"), 60, ["post.12"]);

    expect((await getPageCacheEntry(key))?.body).toBe("<p>memory</p>");
  });

  it("builds one page-cache driver per app driver, not per request, and disconnects a replaced one", async () => {
    const disconnect = vi.spyOn(SharedBackendDriver.prototype, "disconnect");

    await bootDeployment({ driver: SharedBackendDriver, globalPrefix: "", namespace: "staging" });

    const before = SharedBackendDriver.instances;

    for (let request = 0; request < 5; request++) {
      await getPageCacheEntry(keyFor("example.com", `/posts/${request}`));
    }

    expect(SharedBackendDriver.instances - before).toBe(1);
    expect(disconnect).not.toHaveBeenCalled();

    await bootDeployment({
      driver: SharedBackendDriver,
      globalPrefix: "",
      namespace: "production",
    });
    await getPageCacheEntry(keyFor("example.com", "/"));

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
  });
});
