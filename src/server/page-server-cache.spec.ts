/**
 * The server-side page cache (`route.cache.serverCache`) — the framework
 * itself holding resolved bytes and serving a HIT without re-running the
 * pipeline, distinct from `route.cache`'s CDN-facing `Cache-Control` (that is
 * `page-route-cache-opt-in.spec.ts`'s job). Same pattern as that suite and
 * `auth-derived-cache-headers.spec.ts`: `renderPageRequest` is mocked,
 * `server.inject()` exercises a real Fastify instance.
 *
 * `@warlock.js/cache` is mocked with a minimal in-memory tagged store —
 * exactly the surface `page-cache-store.ts`/`page-cache-driver.ts` actually
 * use (`cache.get`, `cache.tags(tags).set/get/invalidate`,
 * `cache.currentDriver`). No real cache package is ever touched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHttpPlugins, router, setConfig, type Request } from "@warlock.js/core";
import { WARLOCK_DATA_REQUEST_HEADER, WARLOCK_DATA_REQUEST_VALUE } from "../routing/data-request";
import { NDJSON_CONTENT_TYPE } from "./write-deferred-ndjson-response";
import type { PageCacheOptIn } from "../routing/route-identity";
import type { BufferedCookie } from "./execute-page-request";

const { renderPageRequest, fakeCache, fakeCacheStore, fakeCacheTagIndex } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const tagIndex = new Map<string, Set<string>>();

  const taggedCacheFor = (tags: string[]) => ({
    async set(key: string, value: unknown) {
      store.set(key, value);
      for (const tag of tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
        tagIndex.get(tag)!.add(key);
      }
    },
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async invalidate() {
      for (const tag of tags) {
        for (const key of tagIndex.get(tag) ?? []) store.delete(key);
        tagIndex.delete(tag);
      }
    },
  });

  return {
    renderPageRequest: vi.fn(),
    fakeCacheStore: store,
    fakeCacheTagIndex: tagIndex,
    fakeCache: {
      currentDriver: { name: "memory" as string | undefined },
      async get(key: string) {
        return store.has(key) ? store.get(key) : null;
      },
      tags: (tags: string[]) => taggedCacheFor(tags),
    },
  };
});

vi.mock("./render-page", () => ({ renderPageRequest }));

// Only `cache.get`/`cache.tags`/`cache.currentDriver` are overridden, IN
// PLACE, on the real `CacheManager` singleton `importOriginal` returns —
// everything else (its prototype methods, `registerDriver`, the classes
// core's own cache connector statically imports) is untouched, so this test
// never has to keep its own mock in sync with `@warlock.js/cache`'s full
// export surface, and no real driver (memory, redis, pg) is ever reached
// because `get`/`tags` never delegate to `currentDriver`.
vi.mock("@warlock.js/cache", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realCache = actual.cache as Record<string, unknown>;

  realCache.get = (key: string) => fakeCache.get(key);
  realCache.tags = fakeCache.tags;
  realCache.currentDriver = fakeCache.currentDriver;

  return actual;
});

import { createPageRouteHandler } from "./create-page-route-handler";
import { invalidatePageCache } from "./invalidate-page-cache";
import { resetPageCacheDriverStateForTests } from "./page-cache-driver";

function renderedHtml(overrides: {
  html?: string;
  status?: number;
  usesDefer?: boolean;
  data?: unknown;
  cookies?: BufferedCookie[];
} = {}) {
  return {
    html: overrides.html ?? "<!doctype html><html><body>ok</body></html>",
    status: overrides.status ?? 200,
    headers: {},
    cookies: overrides.cookies ?? [],
    data: overrides.data,
    bundle: undefined,
    usesDefer: overrides.usesDefer ?? false,
  };
}

function renderedJson(overrides: {
  status?: number;
  usesDefer?: boolean;
  data?: unknown;
  deferredKeys?: string[];
} = {}) {
  const data = overrides.data ?? { id: 1 };

  return {
    html: "",
    status: overrides.status ?? 200,
    headers: {},
    cookies: [],
    data,
    bundle: {
      appData: undefined,
      layoutData: undefined,
      pageData: data,
      shared: undefined,
      route: { name: "route", params: {} },
      deferredKeys: overrides.deferredKeys,
    },
    usesDefer: overrides.usesDefer ?? false,
  };
}

const moduleById: Record<string, unknown> = {
  "app.tsx": {},
  "layout.tsx": {},
  "page.tsx": {},
};

function registerRoute(
  urlPath: string,
  server: FastifyInstance,
  cache: PageCacheOptIn,
  options: { methods?: Array<"get" | "post"> } = {},
): void {
  const handler = createPageRouteHandler({
    path: urlPath,
    name: urlPath,
    appFile: "app.tsx",
    layoutFile: "layout.tsx",
    pageFile: "page.tsx",
    loadModule: async (moduleId) => moduleById[moduleId],
    httpServer: server,
    cache,
  });

  for (const method of options.methods ?? ["get"]) {
    router[method](urlPath, handler);
  }
}

/** Whatever the currently running test wants done to `request` mid-render. */
let touchAuth: (request: Request) => void = () => {};

describe("server-side page cache (route.cache.serverCache)", () => {
  const server = Fastify();

  beforeAll(async () => {
    await registerHttpPlugins(server);

    registerRoute("/__scache-basic", server, { public: true, maxAge: 60, serverCache: true, tags: ["basic"] });
    registerRoute("/__scache-locale", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["locale"],
    });
    registerRoute("/__scache-cookie", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["cookie"],
    });
    registerRoute("/__scache-status", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["status"],
    });
    registerRoute(
      "/__scache-post",
      server,
      { public: true, maxAge: 60, serverCache: true, tags: ["post"] },
      { methods: ["get", "post"] },
    );
    registerRoute("/__scache-invalidate", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["invalidate-me"],
    });
    registerRoute("/__scache-fn-tags", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: (data: unknown) => [`fn:${(data as { id: number }).id}`],
    });
    registerRoute("/__scache-plain", server, { public: true, maxAge: 60 });
    registerRoute("/__scache-tenant", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["tenant"],
    });
    registerRoute("/__scache-vary", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["vary"],
      varyBy: (request) => String(request.header("x-preview-theme", "")),
    });
    registerRoute("/__scache-shared-tags", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: (_data, { shared }) => [`theme:${(shared as { theme?: string }).theme}`],
    });
    registerRoute("/__scache-driver-down", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["driver-down"],
    });
    registerRoute("/__scache-streamed", server, {
      public: true,
      maxAge: 60,
      serverCache: true,
      tags: ["streamed"],
    });

    router.scan(server);
  });

  beforeEach(() => {
    renderPageRequest.mockReset();
    touchAuth = () => {};
    renderPageRequest.mockImplementation(
      async (_url: string, options: { createHttp: () => { request: Request } }) => {
        const { request } = options.createHttp();
        touchAuth(request);
        return renderedHtml();
      },
    );
    fakeCacheStore.clear();
    fakeCacheTagIndex.clear();
    resetPageCacheDriverStateForTests();
  });

  afterEach(() => {
    setConfig("auth.cookie.name", undefined as never);
  });

  afterAll(async () => {
    await server.close();
  });

  // ── Miss then hit ──────────────────────────────────────────────────────
  it("misses then hits: the loader runs once, the second identical request is a HIT with the same body/status", async () => {
    const first = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    const second = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-warlock-cache"]).toBe("hit");
    expect(second.body).toBe(first.body);
    expect(renderPageRequest).toHaveBeenCalledTimes(1);
  });

  it("a route without serverCache is completely untouched: no x-warlock-cache header, cache never consulted", async () => {
    const response = await server.inject({ method: "GET", url: "/__scache-plain" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-warlock-cache"]).toBeUndefined();
    expect(fakeCacheStore.size).toBe(0);
  });

  // ── Key discrimination ───────────────────────────────────────────────────
  it("a different locale gets a separate entry", async () => {
    // `request.locale` reads `header("locale")` when no `?locale=` query or
    // locale cookie is present (`core/src/http/request.ts`'s `resolveLocale`)
    // — a deterministic way to force two different resolved locales without
    // any localization config.
    const en = await server.inject({ method: "GET", url: "/__scache-locale", headers: { locale: "en" } });
    expect(en.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    const enHit = await server.inject({
      method: "GET",
      url: "/__scache-locale",
      headers: { locale: "en" },
    });
    expect(enHit.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    const fr = await server.inject({ method: "GET", url: "/__scache-locale", headers: { locale: "fr" } });
    expect(fr.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  it("query order is normalised: ?a=1&b=2 and ?b=2&a=1 share one entry", async () => {
    const first = await server.inject({ method: "GET", url: "/__scache-basic?a=1&b=2" });
    expect(first.headers["x-warlock-cache"]).toBe("miss");

    const second = await server.inject({ method: "GET", url: "/__scache-basic?b=2&a=1" });
    expect(second.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);
  });

  it("json and html variants are separate entries", async () => {
    const html = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(html.headers["x-warlock-cache"]).toBe("miss");

    renderPageRequest.mockImplementation(async () => renderedJson());

    const json = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });
    expect(json.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);

    const jsonHit = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });
    expect(jsonHit.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  // ── Auth bypass on HIT — the sharpest test in this suite ─────────────────
  it("an Authorization header on what would otherwise be a HIT bypasses the cache entirely", async () => {
    const miss = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");

    const guestHit = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(guestHit.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    // A credential-carrying request that reaches the real pipeline would, in
    // a real app, have its `Authorization` header verified by
    // `@warlock.js/auth`'s middleware — simulated here the same way
    // `auth-derived-cache-headers.spec.ts` does, by touching
    // `decodedAccessToken` mid-render.
    touchAuth = (request) => {
      request.decodedAccessToken = { userType: "member" };
    };

    const bypassed = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { authorization: "Bearer x" },
    });

    expect(renderPageRequest).toHaveBeenCalledTimes(2);
    expect(bypassed.headers["x-warlock-cache"]).toBe("bypass");
    expect(bypassed.headers["x-warlock-cache"]).not.toBe("hit");
    expect(bypassed.headers["cache-control"]).toBe("private, no-store");
  });

  it("the configured auth cookie (default access_token) on what would otherwise be a HIT bypasses the cache", async () => {
    const miss = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");

    await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    touchAuth = (request) => {
      request.decodedAccessToken = { userType: "member" };
    };

    const bypassed = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { cookie: "access_token=abc" },
    });

    expect(renderPageRequest).toHaveBeenCalledTimes(2);
    expect(bypassed.headers["x-warlock-cache"]).toBe("bypass");
    expect(bypassed.headers["cache-control"]).toBe("private, no-store");
  });

  it("a custom configured auth.cookie.name is honoured for the HIT bypass check", async () => {
    setConfig("auth.cookie.name", "session_token");

    const miss = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");

    await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    const bypassed = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { cookie: "session_token=abc" },
    });

    expect(renderPageRequest).toHaveBeenCalledTimes(2);
    expect(bypassed.headers["x-warlock-cache"]).toBe("bypass");
  });

  // ── Store eligibility ─────────────────────────────────────────────────
  it("an authDerived response is never stored — a subsequent guest request still misses", async () => {
    touchAuth = (request) => {
      request.decodedAccessToken = { userType: "member" };
    };

    const first = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(first.headers["cache-control"]).toBe("private, no-store");

    touchAuth = () => {};

    const second = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(second.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  it("a response that sets a cookie is never stored — a subsequent guest request still misses", async () => {
    renderPageRequest.mockImplementation(async () =>
      renderedHtml({ cookies: [{ name: "session", value: "abc", options: { raw: true } }] }),
    );

    const first = await server.inject({ method: "GET", url: "/__scache-cookie" });
    expect(first.headers["set-cookie"]).toBeDefined();

    renderPageRequest.mockImplementation(async () => renderedHtml());

    const second = await server.inject({ method: "GET", url: "/__scache-cookie" });
    expect(second.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  it("a non-200 status is never stored — a subsequent guest request still misses", async () => {
    renderPageRequest.mockImplementation(async () => renderedHtml({ status: 500 }));

    const first = await server.inject({ method: "GET", url: "/__scache-status" });
    expect(first.statusCode).toBe(500);

    renderPageRequest.mockImplementation(async () => renderedHtml());

    const second = await server.inject({ method: "GET", url: "/__scache-status" });
    expect(second.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  it("POST is never cached; a GET to the same URL is unaffected", async () => {
    const post = await server.inject({ method: "POST", url: "/__scache-post" });
    expect(post.statusCode).toBe(200);
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    const get1 = await server.inject({ method: "GET", url: "/__scache-post" });
    expect(get1.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);

    const get2 = await server.inject({ method: "GET", url: "/__scache-post" });
    expect(get2.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  // ── Invalidation ─────────────────────────────────────────────────────────
  it("invalidatePageCache(tags) makes the next request for a previously-hit URL miss again", async () => {
    await server.inject({ method: "GET", url: "/__scache-invalidate" });
    const hit = await server.inject({ method: "GET", url: "/__scache-invalidate" });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    await invalidatePageCache(["invalidate-me"]);

    const missAgain = await server.inject({ method: "GET", url: "/__scache-invalidate" });
    expect(missAgain.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  it("resolves a function-form tags to include the returned tag, invalidatable the same way", async () => {
    renderPageRequest.mockImplementation(async () => renderedHtml({ data: { id: 42 } }));

    await server.inject({ method: "GET", url: "/__scache-fn-tags" });
    const hit = await server.inject({ method: "GET", url: "/__scache-fn-tags" });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");

    await invalidatePageCache(["fn:42"]);

    const missAgain = await server.inject({ method: "GET", url: "/__scache-fn-tags" });
    expect(missAgain.headers["x-warlock-cache"]).toBe("miss");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  // ── Deferred pages are cached fully resolved ─────────────────────────────
  it("forces full resolution on a miss: crawler:true for html, awaitDeferredForDataRequest:true for json", async () => {
    await server.inject({ method: "GET", url: "/__scache-basic" });
    const htmlCallOptions = renderPageRequest.mock.calls[0]![1] as { crawler?: boolean };
    expect(htmlCallOptions.crawler).toBe(true);

    renderPageRequest.mockImplementation(async () => renderedJson());

    await server.inject({
      method: "GET",
      url: "/__scache-locale",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE, accept: NDJSON_CONTENT_TYPE },
    });
    const jsonCallOptions = renderPageRequest.mock.calls[1]![1] as {
      awaitDeferredForDataRequest?: boolean;
    };
    expect(jsonCallOptions.awaitDeferredForDataRequest).toBe(true);
  });

  it("a HIT never re-invokes the render pipeline — the stored body is byte-identical to the MISS", async () => {
    const miss = await server.inject({ method: "GET", url: "/__scache-basic" });
    const hit = await server.inject({ method: "GET", url: "/__scache-basic" });

    expect(hit.body).toBe(miss.body);
    expect(renderPageRequest).toHaveBeenCalledTimes(1);
  });

  // ── Locale switch persists even when served from the cache ─────────────
  it("a HIT still persists a requested locale switch: Set-Cookie and Cache-Control both reflect it", async () => {
    renderPageRequest.mockImplementation(async () => renderedJson());

    const first = await server.inject({
      method: "GET",
      url: "/__scache-locale?locale=ar",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });
    expect(first.headers["x-warlock-cache"]).toBe("miss");
    expect(first.headers["set-cookie"]).toBeDefined();
    expect(String(first.headers["set-cookie"])).toContain("ar");

    const second = await server.inject({
      method: "GET",
      url: "/__scache-locale?locale=ar",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });
    expect(second.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);

    // The bug: a HIT returned the right (cached) body while never calling
    // `response.setLocale()`, so no `Set-Cookie` was ever emitted and the
    // next full load would silently revert to the old locale.
    expect(second.headers["set-cookie"]).toBeDefined();
    expect(String(second.headers["set-cookie"])).toContain("ar");

    // A per-visitor locale cookie must never be replayed from a shared
    // cache as publicly cacheable — the same floor a MISS gets from
    // `applyResponseCacheFloor` (`response-cache-floor.ts`), applied here by
    // `set-cookie-cache-floor-hook.ts`'s `onSend` hook.
    expect(second.headers["cache-control"]).toBe("private, no-store");
  });

  it("a plain HIT with no `?locale=` on the request never persists anything: no Set-Cookie, public Cache-Control kept", async () => {
    const first = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(first.headers["x-warlock-cache"]).toBe("miss");

    const second = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(second.headers["x-warlock-cache"]).toBe("hit");
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(second.headers["cache-control"]).toBe("public, max-age=60");
  });

  // ── Vary correctness for shared caches ───────────────────────────────────
  // A CDN in front of this framework keeps the HTML and JSON representations
  // of a `route.cache` route apart ONLY if every response — HTML included —
  // carries `Vary: x-warlock-data`. These three specs pin that down (a, b,
  // c), and exercise real Fastify `reply.header()` semantics via
  // `server.inject()` rather than a `vi.fn()` mock, because a plain mock
  // records every call and would never reveal a second `header("Vary", ...)`
  // call silently overwriting the first.
  it("(a) the HTML response of a route.cache route carries Vary containing x-warlock-data, on both MISS and HIT", async () => {
    const miss = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");
    expect(String(miss.headers["vary"] ?? "")).toContain(WARLOCK_DATA_REQUEST_HEADER);

    const hit = await server.inject({ method: "GET", url: "/__scache-basic" });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");
    expect(String(hit.headers["vary"] ?? "")).toContain(WARLOCK_DATA_REQUEST_HEADER);
  });

  it("(b) a deferred page HIT carries both User-Agent and x-warlock-data in Vary", async () => {
    renderPageRequest.mockImplementation(async () => renderedJson({ usesDefer: true }));

    const miss = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");

    const hit = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");

    const vary = String(hit.headers["vary"] ?? "");
    expect(vary).toContain("User-Agent");
    expect(vary).toContain(WARLOCK_DATA_REQUEST_HEADER);
  });

  it("(c) the JSON response still carries x-warlock-data in Vary", async () => {
    renderPageRequest.mockImplementation(async () => renderedJson());

    const response = await server.inject({
      method: "GET",
      url: "/__scache-basic",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });

    expect(String(response.headers["vary"] ?? "")).toContain(WARLOCK_DATA_REQUEST_HEADER);
  });

  // ── Tenants and themes never share an entry ─────────────────────────────
  it("two tenants on different hosts never share an entry for the same URL", async () => {
    renderPageRequest.mockImplementation(
      async (_url: string, options: { createHttp: () => { request: Request } }) => {
        const { request } = options.createHttp();
        return renderedHtml({ html: `<html><body>${String(request.header("host"))}</body></html>` });
      },
    );

    const alpha = await server.inject({ method: "GET", url: "/__scache-tenant", headers: { host: "alpha.test" } });
    expect(alpha.headers["x-warlock-cache"]).toBe("miss");

    const beta = await server.inject({ method: "GET", url: "/__scache-tenant", headers: { host: "beta.test" } });
    expect(beta.headers["x-warlock-cache"]).toBe("miss");
    expect(beta.body).toContain("beta.test");
    expect(beta.body).not.toContain("alpha.test");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);

    const alphaAgain = await server.inject({
      method: "GET",
      url: "/__scache-tenant",
      headers: { host: "alpha.test" },
    });
    expect(alphaAgain.headers["x-warlock-cache"]).toBe("hit");
    expect(alphaAgain.body).toContain("alpha.test");
  });

  it("route.cache.varyBy splits entries on the same host (e.g. a preview-theme header)", async () => {
    const a = await server.inject({ method: "GET", url: "/__scache-vary", headers: { "x-preview-theme": "a" } });
    const b = await server.inject({ method: "GET", url: "/__scache-vary", headers: { "x-preview-theme": "b" } });
    const aAgain = await server.inject({
      method: "GET",
      url: "/__scache-vary",
      headers: { "x-preview-theme": "a" },
    });

    expect(a.headers["x-warlock-cache"]).toBe("miss");
    expect(b.headers["x-warlock-cache"]).toBe("miss");
    expect(aAgain.headers["x-warlock-cache"]).toBe("hit");
    expect(renderPageRequest).toHaveBeenCalledTimes(2);
  });

  it("a function-form tags receives the request's shared payload, so entries can be tagged by theme", async () => {
    renderPageRequest.mockImplementation(async () => ({
      ...renderedHtml(),
      bundle: { shared: { theme: "alpha" } },
    }));

    await server.inject({ method: "GET", url: "/__scache-shared-tags" });
    const hit = await server.inject({ method: "GET", url: "/__scache-shared-tags" });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");

    await invalidatePageCache(["theme:alpha"]);

    const missAgain = await server.inject({ method: "GET", url: "/__scache-shared-tags" });
    expect(missAgain.headers["x-warlock-cache"]).toBe("miss");
  });

  // ── The stored document is the one the visitor received ──────────────────
  it("stores the streamed document, not the synchronous escalation pass (which renders Suspense fallbacks)", async () => {
    renderPageRequest.mockImplementation(async () => ({
      ...renderedHtml({ html: "<html><body><p>loading theme</p></body></html>" }),
      pipeableStream: {
        pipe<T extends NodeJS.WritableStream>(destination: T): T {
          destination.write("<html><body><section>alpha theme</section></body></html>");
          destination.end();
          return destination;
        },
        abort() {},
      },
    }));

    const miss = await server.inject({ method: "GET", url: "/__scache-streamed" });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");
    expect(miss.body).toContain("alpha theme");

    const hit = await server.inject({ method: "GET", url: "/__scache-streamed" });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");
    expect(hit.body).toBe(miss.body);
    expect(hit.body).not.toContain("loading theme");
  });

  // ── A cache failure must never be silent ──────────────────────────────────
  it("logs a cache failure server-side, with the error name and message, before the 500 renders", async () => {
    class CacheDriverNotInitializedError extends Error {
      public constructor() {
        super("Cache driver is not initialized");
        this.name = "CacheDriverNotInitializedError";
      }
    }

    const originalGet = fakeCache.get;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    fakeCache.get = async () => {
      throw new CacheDriverNotInitializedError();
    };

    try {
      const response = await server.inject({ method: "GET", url: "/__scache-driver-down" });

      expect(response.statusCode).toBe(500);
      expect(renderPageRequest).not.toHaveBeenCalled();

      const report = logged.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].startsWith("[warlock:web]"),
      );

      expect(report).toBeDefined();
      expect(String(report![0])).toContain("/__scache-driver-down");
      expect(report!.some((arg) => arg instanceof CacheDriverNotInitializedError)).toBe(true);
    } finally {
      fakeCache.get = originalGet;
      logged.mockRestore();
    }
  });

  // ── Missing @warlock.js/cache dependency ─────────────────────────────────
  it("fails loudly, naming @warlock.js/cache, when the module cannot be loaded", async () => {
    vi.doMock("@warlock.js/cache", () => {
      throw new Error("Cannot find module '@warlock.js/cache'");
    });
    resetPageCacheDriverStateForTests();

    // Re-import a fresh copy of the driver module so it picks up the
    // rejecting mock above instead of the memoized module-level promise from
    // this file's top-level `vi.mock`.
    vi.resetModules();
    const { loadPageCacheDriver } = await import("./page-cache-driver");

    await expect(loadPageCacheDriver()).rejects.toThrow(/@warlock\.js\/cache/);

    vi.doUnmock("@warlock.js/cache");
    vi.resetModules();
  });
});
