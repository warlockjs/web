import { describe, expect, it } from "vitest";
import { computePageCacheKey, type PageCacheKeyInput } from "./page-cache-key";

const base: PageCacheKeyInput = {
  host: "alpha.test",
  path: "/products",
  query: {},
  locale: "en",
  variant: "html",
};

describe("computePageCacheKey — tenant isolation", () => {
  it("separates changed route copy from prior JSON and legacy cache entries", () => {
    const first = computePageCacheKey({ ...base, translationsRevision: "one" });
    expect(first).not.toBe(computePageCacheKey({ ...base, translationsRevision: "two" }));
    expect(first).not.toBe(computePageCacheKey(base));
  });
  it("gives two hosts serving the same URL two different keys", () => {
    expect(computePageCacheKey(base)).not.toBe(computePageCacheKey({ ...base, host: "beta.test" }));
  });

  it("treats host case as irrelevant, the way DNS does", () => {
    expect(computePageCacheKey({ ...base, host: "Alpha.TEST" })).toBe(computePageCacheKey(base));
  });

  it("keeps the port, since two ports on one host can be two different apps", () => {
    expect(computePageCacheKey({ ...base, host: "alpha.test:8080" })).not.toBe(
      computePageCacheKey(base),
    );
  });

  it("gives two varyBy values on the same host two different keys", () => {
    expect(computePageCacheKey({ ...base, vary: "theme=a" })).not.toBe(
      computePageCacheKey({ ...base, vary: "theme=b" }),
    );
  });

  it("does not let a crafted path collide with another host's key", () => {
    const crafted = computePageCacheKey({ ...base, host: "alpha.test", path: "/x" });
    const other = computePageCacheKey({ ...base, host: "alpha.test/x", path: "/" });

    expect(crafted).not.toBe(other);
  });

  it("still collides for identical inputs", () => {
    expect(computePageCacheKey({ ...base, vary: "v" })).toBe(
      computePageCacheKey({ ...base, vary: "v" }),
    );
  });
});

describe("computePageCacheKey — query bounds", () => {
  const base = { host: "a.test", path: "/p", locale: "en", variant: "html" } as const;

  it("ignores tracking params by default", () => {
    expect(computePageCacheKey({ ...base, query: { utm_source: "x", fbclid: "1", page: "2" } })).toBe(
      computePageCacheKey({ ...base, query: { page: "2" } }),
    );
  });

  it("keeps only allowlisted keys when an allowlist is set", () => {
    expect(
      computePageCacheKey({ ...base, query: { x: "random", page: "2" }, queryAllowlist: ["page"] }),
    ).toBe(computePageCacheKey({ ...base, query: { page: "2" }, queryAllowlist: ["page"] }));
  });
});
