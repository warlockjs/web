import { describe, expect, it, vi } from "vitest";
import type { SharedContext } from "../index";
import type { PageMetadata } from "../metadata";
import type { PipelineLoader } from "./execute-page-request";
import { ERROR_PAGE_METADATA, resolvePageMetadata } from "./resolve-page-metadata";

const shared = Object.freeze({}) as Readonly<SharedContext>;

/**
 * The shape every reference-app page uses today — `({ data }) => ...`, reading
 * the loader's data with no guard, because the type says `data` is always
 * there (`home.page.tsx:75`, `product-details.page.tsx:72`,
 * `products.page.tsx:82`). If stage 8 ever calls it without data, this throws.
 */
const dataReadingMetadata = (({ data }) => ({
  title: "Home",
  description: `${(data as { products: unknown[] }).products.length} products in stock`,
})) as PageMetadata<PipelineLoader>;

function resolve(overrides: Partial<Parameters<typeof resolvePageMetadata>[0]> = {}) {
  return resolvePageMetadata({
    metadata: undefined,
    data: undefined,
    error: undefined,
    failed: false,
    shared,
    ...overrides,
  });
}

describe("resolvePageMetadata — the success path", () => {
  it("returns undefined when the page exports no metadata", () => {
    expect(resolve()).toEqual({ metadata: undefined });
  });

  it("returns the object form as-is", () => {
    const metadata = { title: "Contact us" };

    expect(resolve({ metadata })).toEqual({ metadata });
  });

  it("calls the function form with the loader's data and no error", () => {
    const metadata = vi.fn(() => ({ title: "Home" })) as unknown as PageMetadata<PipelineLoader>;
    const data = { products: [1, 2, 3] };

    expect(resolve({ metadata, data })).toEqual({ metadata: { title: "Home" } });
    expect(metadata).toHaveBeenCalledWith({ data, shared });
  });
});

describe("resolvePageMetadata — the error path", () => {
  /*
    The card this file closes: a loader rejected, stage 8 called `metadata`
    anyway with `data: undefined`, and the resulting TypeError REPLACED the
    loader's error. A `MissingDataSourceError` became "Cannot read properties
    of undefined" pointing at a different file, in a different subsystem.
  */
  it("does not call the page's metadata function at all", () => {
    const metadata = vi.fn(() => ({ title: "never" })) as unknown as PageMetadata<PipelineLoader>;

    resolve({ metadata, failed: true, error: new Error("loader blew up") });

    expect(metadata).not.toHaveBeenCalled();
  });

  it("does not throw when the page's metadata reads its data unguarded", () => {
    expect(() =>
      resolve({
        metadata: dataReadingMetadata,
        failed: true,
        error: new Error("MissingDataSourceError"),
      }),
    ).not.toThrow();
  });

  it("emits the framework's error metadata, noindex included", () => {
    expect(resolve({ metadata: dataReadingMetadata, failed: true, error: new Error("x") })).toEqual({
      metadata: ERROR_PAGE_METADATA,
    });

    // The part that is not cosmetic: a 500 must never be indexed.
    expect(ERROR_PAGE_METADATA.robots).toBe("noindex");
  });

  it("skips the object form too — a failed page is not 'Sign in'", () => {
    expect(resolve({ metadata: { title: "Sign in" }, failed: true, error: new Error("x") })).toEqual(
      { metadata: ERROR_PAGE_METADATA },
    );
  });
});

describe("resolvePageMetadata — a metadata function that throws", () => {
  it("reports the throw on the success path instead of letting it escape", () => {
    const boom = new Error("metadata is broken");
    const metadata = (() => {
      throw boom;
    }) as unknown as PageMetadata<PipelineLoader>;

    // Reported, not thrown: the caller turns it into an error record so the
    // boundary renders and the framework still owns the status.
    expect(resolve({ metadata, data: {} })).toEqual({ metadata: undefined, thrown: boom });
  });

  it("never reports a throw on the error path — there is nothing left to run", () => {
    const result = resolve({
      metadata: dataReadingMetadata,
      failed: true,
      error: new Error("the real one"),
    });

    expect(result.thrown).toBeUndefined();
  });
});
