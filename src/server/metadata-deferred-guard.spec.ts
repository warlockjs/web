import { describe, expect, it } from "vitest";
import {
  DeferredKeyInMetadataError,
  guardMetadataAgainstDeferredKeys,
} from "./metadata-deferred-guard";

describe("guardMetadataAgainstDeferredKeys", () => {
  it("reads a resolved key through untouched", () => {
    const data = { product: { name: "Chair" }, reviews: Promise.resolve([]) };

    const guarded = guardMetadataAgainstDeferredKeys(data, ["reviews"], "/products/1") as {
      product: { name: string };
    };

    expect(guarded.product).toBe(data.product);
  });

  it("throws DeferredKeyInMetadataError naming the key and the page on a deferred read", () => {
    const data = { product: { name: "Chair" }, reviews: Promise.resolve([]) };

    const guarded = guardMetadataAgainstDeferredKeys(data, ["reviews"], "/products/1") as {
      reviews: unknown;
    };

    let thrown: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      guarded.reviews;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DeferredKeyInMetadataError);
    expect((thrown as DeferredKeyInMetadataError).key).toBe("reviews");
    expect((thrown as DeferredKeyInMetadataError).pagePath).toBe("/products/1");
    expect((thrown as Error).message).toContain("reviews");
    expect((thrown as Error).message).toContain("/products/1");
  });

  it("returns data unchanged (no Proxy) for a page that never called defer()", () => {
    const data = { product: { name: "Chair" } };

    expect(guardMetadataAgainstDeferredKeys(data, undefined, "/products/1")).toBe(data);
    expect(guardMetadataAgainstDeferredKeys(data, [], "/products/1")).toBe(data);
  });
});
