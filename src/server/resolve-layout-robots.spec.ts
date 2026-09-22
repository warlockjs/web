import { describe, expect, it } from "vitest";
import { resolveLayoutRobots } from "./resolve-layout-robots";
import type { LayoutModuleShape } from "./page-module-shapes";

describe("resolveLayoutRobots", () => {
  it("uses an outer layout's static robots directive", () => {
    expect(resolveLayoutRobots([{ metadata: { robots: "noindex" } }, {}])).toBe("noindex");
  });

  it("uses the nearest defined directive, including a non-rendering layout", () => {
    expect(
      resolveLayoutRobots([
        { metadata: { robots: "index,follow" } },
        { metadata: { robots: "noindex" } },
        { default: function PageLayout() {} },
      ]),
    ).toBe("noindex");
  });

  it("lets an undefined inner directive leave the outer directive in place", () => {
    expect(
      resolveLayoutRobots([
        { metadata: { robots: "noindex" } },
        { metadata: { robots: undefined } },
      ]),
    ).toBe("noindex");
  });

  it("accepts layouts without metadata", () => {
    expect(resolveLayoutRobots([{}, { metadata: undefined }])).toBeUndefined();
  });

  it("only extracts static string robots and leaves metadata validation to normalization", () => {
    const layouts = [
      { metadata: { title: "Outer" } },
      { metadata: () => ({ robots: "noindex" }) },
      { metadata: { robots: false } },
      { metadata: { robots: "noindex" } },
    ] as unknown as LayoutModuleShape[];

    expect(resolveLayoutRobots(layouts, ["outer/layout.tsx", "inner/layout.tsx"])).toBe("noindex");
  });
});
