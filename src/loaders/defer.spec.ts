import { describe, expect, it } from "vitest";
import {
  DEFERRED_BRAND,
  defer,
  isDeferred,
  NestedDeferredValueError,
  splitDeferredPageData,
} from "./defer";

describe("defer()", () => {
  it("brands its result with DEFERRED_BRAND and preserves the data as-is", () => {
    const promise = Promise.resolve(1);
    const result = defer({ greeting: "hi", reviews: promise });

    expect(result[DEFERRED_BRAND]).toBe(true);
    expect(result.data).toEqual({ greeting: "hi", reviews: promise });
  });

  it("isDeferred narrows a defer() result and rejects everything else", () => {
    expect(isDeferred(defer({}))).toBe(true);
    expect(isDeferred({})).toBe(false);
    expect(isDeferred(null)).toBe(false);
    expect(isDeferred(undefined)).toBe(false);
    expect(isDeferred("not deferred")).toBe(false);
    expect(isDeferred({ [DEFERRED_BRAND]: false })).toBe(false);
  });
});

describe("splitDeferredPageData()", () => {
  it("splits top-level promise keys from resolved keys, preserving declaration order", () => {
    const reviews = Promise.resolve([{ id: 1 }]);
    const related = Promise.resolve([{ id: 2 }]);

    const result = splitDeferredPageData({
      product: { id: 1, name: "Widget" },
      reviews,
      related,
      inStock: true,
    });

    expect(result.deferredKeys).toEqual(["reviews", "related"]);
    // The ORIGINAL promise, untouched — contract rule 4.
    expect(result.pageData.reviews).toBe(reviews);
    expect(result.pageData.related).toBe(related);
    expect(result.pageData.product).toEqual({ id: 1, name: "Widget" });
    expect(result.pageData.inStock).toBe(true);
  });

  it("reports no deferred keys for a plain resolved object", () => {
    const result = splitDeferredPageData({ a: 1, b: "two" });

    expect(result.deferredKeys).toEqual([]);
    expect(result.pageData).toEqual({ a: 1, b: "two" });
  });

  it("throws NestedDeferredValueError naming the path when a promise is nested under a resolved key", () => {
    const nested = Promise.resolve(1);

    expect(() => splitDeferredPageData({ list: { items: nested } })).toThrow(
      NestedDeferredValueError,
    );

    try {
      splitDeferredPageData({ list: { items: nested } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NestedDeferredValueError);
      expect((error as Error).message).toContain("list.items");
    }
  });

  it("names the array index for a promise nested inside a top-level array", () => {
    const nested = Promise.resolve(1);

    expect(() => splitDeferredPageData({ list: [nested] })).toThrowError(/list\[0\]/);
  });

  it("never crosses class-instance boundaries when walking for nested promises", () => {
    class Money {
      public constructor(public readonly cents: number) {}
    }

    expect(() => splitDeferredPageData({ price: new Money(500) })).not.toThrow();
  });
});
