import { describe, expect, it } from "vitest";
import { composePageModule, PageSetupModuleExportError } from "./compose-page-module";

describe("composePageModule", () => {
  it("retains the UI component and adds setup server exports", () => {
    const Page = () => null;
    const loader = () => ({ products: [] });
    const register = () => undefined;

    expect(
      composePageModule(
        { default: Page },
        { config: { route: "/products" }, loader, register },
        "src/web/products.page.tsx",
        "src/web/products.setup.ts",
      ),
    ).toEqual({ default: Page, config: { route: "/products" }, loader, register });
  });

  it("returns the original UI namespace when no setup exists", () => {
    const module = { default: () => null };

    expect(composePageModule(module, undefined, "src/web/index.page.tsx")).toBe(module);
  });

  it("rejects a duplicate export and names both files", () => {
    expect(() =>
      composePageModule(
        { config: { route: "/ui" } },
        { config: { route: "/setup" } },
        "src/web/index.page.tsx",
        "src/web/index.setup.ts",
      ),
    ).toThrow(PageSetupModuleExportError);
    expect(() =>
      composePageModule(
        { config: { route: "/ui" } },
        { config: { route: "/setup" } },
        "src/web/index.page.tsx",
        "src/web/index.setup.ts",
      ),
    ).toThrow('both files export "config"');
  });

  it("refuses a component export from setup", () => {
    expect(() =>
      composePageModule(
        { default: () => null },
        { default: () => null },
        "src/web/index.page.tsx",
        "src/web/index.setup.ts",
      ),
    ).toThrow('setup files may export only config, loader, or register');
  });
});
