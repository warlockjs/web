import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPageCacheEntry, setPageCacheEntry } = vi.hoisted(() => ({
  getPageCacheEntry: vi.fn(),
  setPageCacheEntry: vi.fn(),
}));

vi.mock("../page-cache-store", () => ({ getPageCacheEntry, setPageCacheEntry }));

import { resolvePageCacheHitOrMiss } from "./serve-page-cache-hit";
import {
  reportPageCacheFailure,
  resetPageCacheFailureThrottle,
} from "./store-page-cache-after-render";

const request = {
  method: "GET",
  path: "/s/AbC",
  query: {},
  locale: "en",
  header: () => "alpha.test",
} as never;

describe("page cache backend outage (B3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetPageCacheFailureThrottle();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("treats a failed lookup as a miss that skips the store", async () => {
    getPageCacheEntry.mockRejectedValue(new Error("redis down"));

    const outcome = await resolvePageCacheHitOrMiss({
      request,
      response: {} as never,
      cache: { serverCache: true, public: true, maxAge: 60 } as never,
      credentialedRequest: false,
      pageCacheVariant: "html",
    });

    expect(outcome).toMatchObject({
      served: false,
      cacheHeaderValue: "miss",
      attemptStorageAfterRender: false,
    });
  });

  it("reports at most once per throttle window", () => {
    reportPageCacheFailure("lookup", new Error("a"));
    reportPageCacheFailure("store", new Error("b"));

    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
