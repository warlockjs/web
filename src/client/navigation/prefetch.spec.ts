import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PREFETCH_CACHE_LIMIT,
  PREFETCH_TTL_MS,
  prefetchPageData,
  resetPrefetchCache,
  takePrefetchedPageData,
} from "./prefetch";

/**
 * The prefetch cache, and specifically the four ways a speculative fetch turns
 * into a defect:
 *
 *   - it reports a failure the user never asked for      → it is SILENT
 *   - it grows without bound                             → it is CAPPED
 *   - it serves a payload older than the last mutation   → it EXPIRES
 *   - it runs where there is no browser                  → it NO-OPS
 *
 * Every test here is one of those four. The happy path is a single test,
 * because the happy path is not what makes this feature risky.
 */

const PAYLOAD = { name: "products.list", shared: {} };

function respondWith(
  init: { status?: number; contentType?: string; body?: unknown } = {},
): ReturnType<typeof vi.fn> {
  const status = init.status ?? 200;

  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": init.contentType ?? "application/json" }),
    url: "",
    json: async () => init.body ?? PAYLOAD,
  }));

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  // The suite runs in `node`, where there is no `window` — which is exactly the
  // condition `prefetchPageData` refuses to run under, so a browser has to be
  // stated explicitly for anything here to happen at all.
  vi.stubGlobal("window", {});
  resetPrefetchCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPrefetchCache();
});

describe("prefetchPageData", () => {
  it("caches the payload under the requested URL", async () => {
    respondWith();

    await prefetchPageData("/products");

    expect(takePrefetchedPageData("/products")).toEqual({
      type: "payload",
      payload: PAYLOAD,
      url: "/products",
    });
  });

  it("asks for page data, not a document", async () => {
    const fetchMock = respondWith();

    await prefetchPageData("/products");

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect((requestInit.headers as Record<string, string>)["x-warlock-data"]).toBeDefined();
  });

  it("does not re-fetch a URL already cached", async () => {
    const fetchMock = respondWith();

    await prefetchPageData("/products");
    await prefetchPageData("/products");

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("issues ONE request for concurrent prefetches of the same URL", async () => {
    const fetchMock = respondWith();

    await Promise.all([prefetchPageData("/products"), prefetchPageData("/products")]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not cache a result the navigation would have to hard-navigate", async () => {
    respondWith({ status: 404 });

    await prefetchPageData("/missing");

    expect(takePrefetchedPageData("/missing")).toBeUndefined();
  });

  it("is silent when the request fails outright", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await expect(prefetchPageData("/products")).resolves.toBeUndefined();

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(takePrefetchedPageData("/products")).toBeUndefined();
  });

  it("frees the in-flight slot after a failure, so a later hover may retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await prefetchPageData("/products");

    const fetchMock = respondWith();

    await prefetchPageData("/products");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(takePrefetchedPageData("/products")).toBeDefined();
  });

  it("does nothing at all without a browser", async () => {
    const fetchMock = respondWith();

    vi.stubGlobal("window", undefined);

    await prefetchPageData("/products");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(takePrefetchedPageData("/products")).toBeUndefined();
  });
});

describe("takePrefetchedPageData", () => {
  it("returns undefined for a URL nobody prefetched", () => {
    expect(takePrefetchedPageData("/never-hovered")).toBeUndefined();
  });

  /*
    CONSUMING, not peeking. One hover buys one saved round trip: serving the
    same payload to a second navigation doubles the window in which it can be
    stale, for a saving the user never noticed the first time.
  */
  it("consumes the entry, so a second navigation fetches fresh", async () => {
    respondWith();

    await prefetchPageData("/products");

    expect(takePrefetchedPageData("/products")).toBeDefined();
    expect(takePrefetchedPageData("/products")).toBeUndefined();
  });
});

describe("the bound", () => {
  it(`keeps at most ${PREFETCH_CACHE_LIMIT} entries, dropping the oldest first`, async () => {
    respondWith();

    for (let index = 0; index <= PREFETCH_CACHE_LIMIT; index++) {
      await prefetchPageData(`/page-${index}`);
    }

    // The first URL hovered is the one evicted; the last is still there.
    expect(takePrefetchedPageData("/page-0")).toBeUndefined();
    expect(takePrefetchedPageData(`/page-${PREFETCH_CACHE_LIMIT}`)).toBeDefined();
  });
});

describe("expiry", () => {
  it("serves an entry inside the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    respondWith();

    await prefetchPageData("/products");

    vi.setSystemTime(PREFETCH_TTL_MS - 1);

    expect(takePrefetchedPageData("/products")).toBeDefined();
  });

  it("refuses an entry older than the TTL, because a stale page is a wrong page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    respondWith();

    await prefetchPageData("/products");

    vi.setSystemTime(PREFETCH_TTL_MS + 1);

    expect(takePrefetchedPageData("/products")).toBeUndefined();
  });

  it("re-fetches a URL whose cached entry has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fetchMock = respondWith();

    await prefetchPageData("/products");

    vi.setSystemTime(PREFETCH_TTL_MS + 1);

    await prefetchPageData("/products");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
