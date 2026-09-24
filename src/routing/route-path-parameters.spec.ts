import { describe, expect, it } from "vitest";
import { parseRoutePathParameters } from "./route-path-parameters";

describe("parseRoutePathParameters", () => {
  it("recognizes required, optional, and wildcard whole-segment parameters", () => {
    expect(parseRoutePathParameters("/posts/:id/:slug?/*")).toEqual({
      type: "precise",
      parameters: [
        { name: "id", optional: false },
        { name: "slug", optional: true },
        { name: "*", optional: false },
      ],
    });
  });

  it("uses broad parameters for syntax it cannot represent safely", () => {
    expect(parseRoutePathParameters("/posts/:id(\\d+)")).toEqual({ type: "broad" });
    expect(parseRoutePathParameters("/files/*/details")).toEqual({ type: "broad" });
  });
});
