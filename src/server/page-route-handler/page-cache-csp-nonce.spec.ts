import { describe, expect, it, vi } from "vitest";

const { getPageCacheEntry } = vi.hoisted(() => ({ getPageCacheEntry: vi.fn() }));

vi.mock("../page-cache-store", () => ({ getPageCacheEntry, setPageCacheEntry: vi.fn() }));
vi.mock("@warlock.js/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  config: { get: (key: string) => (key === "http.csp" ? { enabled: true } : undefined) },
}));

import { resolvePageCacheHitOrMiss } from "./serve-page-cache-hit";

const request = {
  method: "GET",
  path: "/",
  query: {},
  locale: "en",
  header: () => "alpha.test",
} as never;

const cache = { serverCache: true, public: true, maxAge: 60 } as never;

describe("page cache with CSP nonces (B4)", () => {
  it("never looks up or replays a stored HTML document while CSP is enabled", async () => {
    getPageCacheEntry.mockResolvedValue({ body: '<script nonce="old">', status: 200 });

    const outcome = await resolvePageCacheHitOrMiss({
      request,
      response: {} as never,
      cache,
      credentialedRequest: false,
      pageCacheVariant: "html",
    });

    expect(getPageCacheEntry).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ served: false, attemptStorageAfterRender: false });
  });
});
