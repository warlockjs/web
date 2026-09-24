import { describe, expect, it } from "vitest";
import { href, publishRouteTable, resetRouteTable } from "./route-table";
import { interpolateRoutePath } from "./route-path-interpolation";

function interpolateFormPath(path: string, params: Record<string, unknown>): string {
  return interpolateRoutePath(path, params, {
    isMissing: (value) => value === undefined || value === null,
    onMissingParameter: (name) => {
      throw new Error(
        `Submit route ${JSON.stringify(path)} is missing path parameter ${JSON.stringify(name)}.`,
      );
    },
  });
}

describe("interpolateRoutePath", () => {
  it("interpolates and encodes required and wildcard parameters for pages and forms alike", () => {
    publishRouteTable([{ name: "files.show", path: "/files/:id/*" }]);

    expect(href("files.show", { id: "a b", "*": "nested/path" })).toBe(
      "/files/a%20b/nested%2Fpath",
    );
    expect(interpolateFormPath("/files/:id/*", { id: "a b", "*": "nested/path" })).toBe(
      "/files/a%20b/nested%2Fpath",
    );

    resetRouteTable();
  });

  it("omits an optional whole segment cleanly, including from the root", () => {
    expect(interpolateFormPath("/posts/:id?/comments", { id: null })).toBe("/posts/comments");
    expect(interpolateFormPath("/:locale?", { locale: undefined })).toBe("/");
  });

  it("retains href's public missing and unknown parameter errors", () => {
    publishRouteTable([{ name: "posts.show", path: "/posts/:id" }]);

    expect(() => href("posts.show")).toThrow(
      'Warlock href("posts.show") is missing the parameter "id"',
    );
    expect(() => href("posts.show", { typo: "x" })).toThrow(
      'Warlock href("posts.show") was given "typo"',
    );

    resetRouteTable();
  });

  it("uses legacy behavior for grammar the parser cannot safely narrow", () => {
    expect(interpolateFormPath("/posts/:id(\\d+)", { id: 7 })).toBe("/posts/7(\\d+)");
  });
});
