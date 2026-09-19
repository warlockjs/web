import { afterEach, describe, expect, it, vi } from "vitest";
import { warnMissingAlt } from "./warn-missing-alt";

// `import.meta.env.DEV` is flipped for the duration of each case, the same
// pattern `build-hydrated-tree.spec.ts` uses for its own development-only
// invariant, and restored afterwards.
describe("warnMissingAlt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = false;
  });

  it("logs one console.error naming the src in DEV when alt is missing", () => {
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    warnMissingAlt("/uploads/cover.jpg", undefined);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain("/uploads/cover.jpg");
  });

  it("stays silent in DEV when alt is provided (including empty string)", () => {
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    warnMissingAlt("/uploads/cover.jpg", "");
    warnMissingAlt("/uploads/cover.jpg", "A mountain");

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("stays silent outside DEV even when alt is missing", () => {
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    warnMissingAlt("/uploads/cover.jpg", undefined);

    expect(consoleError).not.toHaveBeenCalled();
  });
});
