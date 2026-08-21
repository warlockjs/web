import { describe, expect, it } from "vitest";
import { shared, useShared } from "../../src/shared";

/**
 * Separate file on purpose: vitest isolates module state per test file, so
 * this is the one place `shared` is genuinely unconnected — the state of any
 * consumer that imports `shared` before the pipeline bootstrap ran (module
 * load, a background job's process).
 */
describe("shared before connectSharedStore", () => {
  it("read throws naming the bootstrap fix", () => {
    expect(() => (shared as Record<string, any>).locale).toThrowError(
      /not connected to a request store/,
    );
    expect(() => (shared as Record<string, any>).locale).toThrowError(/connectSharedStore/);
  });

  it("useShared throws the same named error", () => {
    expect(() => useShared()).toThrowError(/connectSharedStore/);
  });
});
