import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRAMEWORK_DEFAULT_NOT_FOUND_STYLESHEET } from "./framework-default-not-found-stylesheet";

/**
 * `FRAMEWORK_DEFAULT_NOT_FOUND_STYLESHEET` is a duplicate of
 * `framework-default-not-found.css`, forced to exist only because the
 * production server build refuses static-asset imports in the page graph.
 * Two copies of the same styling drift apart the moment one is edited and
 * the other is not — this spec is what keeps them one source of truth in
 * practice, by failing loudly the instant a single byte disagrees.
 */
describe("the duplicated not-found stylesheet stays byte-identical to its source file", () => {
  it("matches framework-default-not-found.css exactly", () => {
    const cssFileContent = readFileSync(join(__dirname, "framework-default-not-found.css"), "utf8");

    expect(FRAMEWORK_DEFAULT_NOT_FOUND_STYLESHEET).toBe(cssFileContent);
  });
});
