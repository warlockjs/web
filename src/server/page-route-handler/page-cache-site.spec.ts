import { describe, expect, it, vi } from "vitest";

const { getPageCacheEntry } = vi.hoisted(() => ({ getPageCacheEntry: vi.fn() }));

vi.mock("../page-cache-store", () => ({ getPageCacheEntry, setPageCacheEntry: vi.fn() }));
vi.mock("@warlock.js/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  config: { get: (key: string) => (key === "app.url" ? "https://a.test" : undefined) },
}));

import { resolvePageCacheHitOrMiss } from "./serve-page-cache-hit";

const cache = { serverCache: true, public: true, maxAge: 60 } as never;

describe("page cache selected site", () => {
  it("does not bypass a selected site on a foreign host when app.url is set", async () => {
    getPageCacheEntry.mockClear();
    getPageCacheEntry.mockResolvedValue(undefined);

    const outcome = await resolvePageCacheHitOrMiss({
      request: {
        method: "GET",
        path: "/",
        query: {},
        locale: "en",
        header: () => "Tenant.TEST:8080",
        site: { key: "tenant", tenantKey: "acme" },
      } as never,
      response: {} as never,
      cache,
      credentialedRequest: false,
      pageCacheVariant: "html",
    });

    expect(getPageCacheEntry).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      cacheHeaderValue: "miss",
      cacheKey: "tenant.test%3A8080/?|en|html|site=tenant|tenantKey=acme",
      attemptStorageAfterRender: true,
    });
  });
});
