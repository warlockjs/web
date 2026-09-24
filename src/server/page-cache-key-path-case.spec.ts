import { describe, expect, it } from "vitest";
import { computePageCacheKey } from "./page-cache-key";

const base = { host: "alpha.test", query: {}, locale: "en", variant: "html" as const };

describe("computePageCacheKey — path case (B2)", () => {
  it("keeps /users/Alice and /users/alice as two entries", () => {
    expect(computePageCacheKey({ ...base, path: "/users/Alice" })).not.toBe(
      computePageCacheKey({ ...base, path: "/users/alice" }),
    );
  });

  it("still lower-cases the host", () => {
    expect(computePageCacheKey({ ...base, host: "ALPHA.test", path: "/x" })).toBe(
      computePageCacheKey({ ...base, path: "/x" }),
    );
  });
});
