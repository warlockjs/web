import { stringify } from "devalue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPrefetchCache } from "../../index";
import {
  prefetchPageData,
  resetPrefetchCache,
  takePrefetchedPageData,
} from "./prefetch";
import { createRefresher, type RefreshRuntime, type RefreshablePage } from "./refresh";

/**
 * A hovered link must not survive a `refresh()` or an explicit clear: the user
 * hovers "Account", logs out, clicks "Account" within 30s and must NOT get the
 * cached logged-in page (B2).
 */

const PAYLOAD = {
  appData: {},
  layoutData: {},
  pageData: {},
  shared: {},
  name: "account",
  locale: "en",
  translations: {},
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      url,
      text: async () => stringify(PAYLOAD),
    })),
  );
}

beforeEach(() => {
  stubFetch();
  vi.stubGlobal("window", { location: { href: "https://app.test/products" }, history: {} });
  resetPrefetchCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPrefetchCache();
});

describe("prefetch invalidation", () => {
  it("clearPrefetchCache (public export) drops a hovered page", async () => {
    await prefetchPageData("/account");
    clearPrefetchCache();

    expect(takePrefetchedPageData("/account")).toBeUndefined();
  });

  it("a prefetch still in flight when the cache is cleared is not written back", async () => {
    const pending = prefetchPageData("/account");

    clearPrefetchCache();
    await pending;

    expect(takePrefetchedPageData("/account")).toBeUndefined();
  });

  it("a successful refresh() clears the cache", async () => {
    await prefetchPageData("/account");

    const page: RefreshablePage = { payload: PAYLOAD, tree: "t", routeSource: PAYLOAD };
    const runtime: RefreshRuntime = {
      readCurrent: () => page,
      writeCurrent: () => undefined,
      buildTree: async () => "t",
      claimTicket: () => ({ isCurrent: () => true, signal: new AbortController().signal }),
    };

    expect(await createRefresher(runtime)()).toBe(true);
    expect(takePrefetchedPageData("/account")).toBeUndefined();
  });
});
