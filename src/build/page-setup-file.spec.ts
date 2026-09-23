import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageSetupFileFor, pageSetupOwnerFileFor } from "./page-setup-file";

describe("pageSetupFileFor", () => {
  it.each([
    ["index.page.tsx", "index.setup.ts"],
    ["products/item.page.tsx", "products/item.setup.ts"],
    ["layout.tsx", "layout.setup.ts"],
    ["root.tsx", "root.setup.ts"],
  ])("pairs %s with %s", (file, expected) => {
    expect(pageSetupFileFor(path.resolve("src/web", file))).toBe(path.resolve("src/web", expected));
  });

  it("does not treat an arbitrary UI file as a setup owner", () => {
    expect(pageSetupFileFor("src/web/widget.tsx")).toBeUndefined();
  });
});

describe("pageSetupOwnerFileFor", () => {
  it.each([
    ["index.setup.ts", "index.page.tsx"],
    ["catalog/item.setup.ts", "catalog/item.page.tsx"],
    ["layout.setup.ts", "layout.tsx"],
    ["root.setup.ts", "root.tsx"],
  ])("maps %s back to %s", (file, expected) => {
    expect(pageSetupOwnerFileFor(path.resolve("src/web", file))).toBe(path.resolve("src/web", expected));
  });
});
