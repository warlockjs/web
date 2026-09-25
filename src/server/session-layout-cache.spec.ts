/**
 * Blog finding R5-1: a layout whose loader returns the current user (behind an
 * optional cookie auth middleware) with child pages that opt into
 * `serverCache`. A signed-in request must never be stored or served from the
 * cache, and a guest must never see user data. Same harness as
 * `page-server-cache.spec.ts`: `renderPageRequest` mocked, real Fastify.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerHttpPlugins, requestContext, router, type Request } from "@warlock.js/core";
import { connectPageContext } from "./page-context";
import type { PageContextRunner } from "./execute-page-request.types";

const { renderPageRequest, fakeCache, fakeCacheStore } = vi.hoisted(() => {
  const store = new Map<string, unknown>();

  const taggedCacheFor = () => ({
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async invalidate() {},
  });

  return {
    renderPageRequest: vi.fn(),
    fakeCacheStore: store,
    fakeCache: {
      currentDriver: new (class FakePageCacheDriver {
        public name: string | undefined = "memory";
        public options: Record<string, unknown> = {};

        public setOptions(options: Record<string, unknown>) {
          this.options = options;
          return this;
        }

        public async connect() {}

        public async disconnect() {}

        public get(key: string) {
          return store.has(key) ? store.get(key) : null;
        }

        public tags() {
          return taggedCacheFor();
        }
      })(),
    },
  };
});

vi.mock("./render-page", () => ({ renderPageRequest }));

vi.mock("@warlock.js/cache", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  (actual.cache as Record<string, unknown>).currentDriver = fakeCache.currentDriver;
  return actual;
});

import { createPageRouteHandler } from "./create-page-route-handler";
import { resetPageCacheDriverStateForTests } from "./page-cache-driver";

const SECRET = "user-jane-secret";

describe("serverCache with a session-dependent layout payload (R5-1)", () => {
  const server = Fastify();
  let previousRunner: PageContextRunner | undefined;

  beforeAll(async () => {
    previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
    await registerHttpPlugins(server);

    const handler = createPageRouteHandler({
      path: "/__slc-page",
      name: "/__slc-page",
      appFile: "app.tsx",
      layoutFile: "layout.tsx",
      pageFile: "page.tsx",
      loadModule: async (moduleId) => (moduleId === "page.tsx" ? { default: (): null => null } : {}),
      httpServer: server,
      cache: { public: true, maxAge: 60, serverCache: true, tags: ["slc"] },
    });

    router.get("/__slc-page", handler);
    router.scan(server);
  });

  beforeEach(() => {
    fakeCacheStore.clear();
    resetPageCacheDriverStateForTests();
    renderPageRequest.mockReset();
    // The layout loader: the cookie auth middleware resolves a user, the
    // loader returns it, and the page embeds it.
    renderPageRequest.mockImplementation(
      async (_url: string, options: { createHttp: () => { request: Request } }) => {
        const { request } = options.createHttp();
        const signedIn = Boolean(request.header("cookie"));

        if (signedIn) request.decodedAccessToken = { userType: "member" };

        return {
          html: `<html><body>${signedIn ? SECRET : "guest"}</body></html>`,
          status: 200,
          headers: {},
          cookies: [],
          data: undefined,
          bundle: undefined,
          usesDefer: false,
        };
      },
    );
  });

  afterAll(async () => {
    connectPageContext(previousRunner);
    await server.close();
  });

  it("a signed-in request is never stored, never served from cache, and is private/no-store", async () => {
    const signedIn = await server.inject({
      method: "GET",
      url: "/__slc-page",
      headers: { cookie: "access_token=abc" },
    });

    expect(signedIn.body).toContain(SECRET);
    expect(signedIn.headers["cache-control"]).toBe("private, no-store");
    expect(signedIn.headers["x-warlock-cache"]).toBe("bypass");
    expect(fakeCacheStore.size).toBe(0);

    // Pre-populate the cache with a guest entry, then a signed-in request must not read it.
    await server.inject({ method: "GET", url: "/__slc-page" });
    expect(fakeCacheStore.size).toBe(1);

    const again = await server.inject({
      method: "GET",
      url: "/__slc-page",
      headers: { cookie: "access_token=abc" },
    });

    expect(again.headers["x-warlock-cache"]).toBe("bypass");
    expect(again.headers["cache-control"]).toBe("private, no-store");
    expect(again.body).toContain(SECRET);
  });

  it("a guest after a signed-in request never receives user data", async () => {
    await server.inject({
      method: "GET",
      url: "/__slc-page",
      headers: { cookie: "access_token=abc" },
    });

    const guest = await server.inject({ method: "GET", url: "/__slc-page" });

    expect(guest.body).not.toContain(SECRET);
    expect(guest.body).toContain("guest");
    expect([...fakeCacheStore.values()].every((v) => !JSON.stringify(v).includes(SECRET))).toBe(true);
  });

  it("a guest miss is stored and served to cookie-less guests", async () => {
    const miss = await server.inject({ method: "GET", url: "/__slc-page" });
    expect(miss.headers["x-warlock-cache"]).toBe("miss");
    expect(fakeCacheStore.size).toBe(1);

    const hit = await server.inject({ method: "GET", url: "/__slc-page" });
    expect(hit.headers["x-warlock-cache"]).toBe("hit");
    expect(hit.body).toBe(miss.body);
    expect(hit.headers["cache-control"]).toBe("public, max-age=60");
    expect(renderPageRequest).toHaveBeenCalledTimes(1);
  });
});
