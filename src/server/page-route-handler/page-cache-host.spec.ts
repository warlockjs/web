import { describe, expect, it, vi } from "vitest";

const { getPageCacheEntry } = vi.hoisted(() => ({ getPageCacheEntry: vi.fn() }));

vi.mock("../page-cache-store", () => ({ getPageCacheEntry, setPageCacheEntry: vi.fn() }));
vi.mock("@warlock.js/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  config: { get: (key: string) => (key === "app.url" ? "https://a.test" : undefined) },
}));

import { resolvePageCacheHitOrMiss, resolvePageCacheHost } from "./serve-page-cache-hit";

const cache = { serverCache: true, public: true, maxAge: 60 } as never;

const lookup = (host: string) =>
  resolvePageCacheHitOrMiss({
    request: { method: "GET", path: "/", query: {}, locale: "en", header: () => host } as never,
    response: {} as never,
    cache,
    credentialedRequest: false,
    pageCacheVariant: "html",
  });

describe("page cache host decision", () => {
  it("bypasses a foreign host: no lookup, no store", async () => {
    getPageCacheEntry.mockClear();

    const outcome = await lookup("b.test");

    expect(getPageCacheEntry).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      served: false,
      cacheHeaderValue: "bypass",
      cacheKey: undefined,
      attemptStorageAfterRender: false,
    });
  });

  it("still looks up and stores for the configured host (case-insensitive)", async () => {
    getPageCacheEntry.mockClear();
    getPageCacheEntry.mockResolvedValue(undefined);

    const outcome = await lookup("A.test");

    expect(getPageCacheEntry).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ cacheHeaderValue: "miss", attemptStorageAfterRender: true });
  });

  it("resolves hosts purely", () => {
    expect(resolvePageCacheHost("b.test")).toBe("bypass");
    expect(resolvePageCacheHost("a.test")).toBe("a.test");
  });
});
