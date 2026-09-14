import { describe, expect, it } from "vitest";
import { layoutPrefixesByDirectory } from "./layout-prefixes";

describe("layoutPrefixesByDirectory", () => {
  it("keys each declared prefix by its own directory", () => {
    const table = layoutPrefixesByDirectory([
      { directory: "", prefix: "/shop" },
      { directory: "account/settings", prefix: "/settings" },
    ]);

    expect(table).toEqual({ "": "/shop", "account/settings": "/settings" });
  });

  it("drops a layout that declares no prefix, rather than recording it as undefined", () => {
    const table = layoutPrefixesByDirectory([
      { directory: "", prefix: undefined },
      { directory: "account", prefix: "/my-account" },
    ]);

    expect(table).toEqual({ account: "/my-account" });
    expect(Object.prototype.hasOwnProperty.call(table, "")).toBe(false);
  });

  it("returns an empty table for an empty chain", () => {
    expect(layoutPrefixesByDirectory([])).toEqual({});
  });

  it("lets a later entry win a directory collision", () => {
    const table = layoutPrefixesByDirectory([
      { directory: "account", prefix: "/first" },
      { directory: "account", prefix: "/second" },
    ]);

    expect(table).toEqual({ account: "/second" });
  });
});
