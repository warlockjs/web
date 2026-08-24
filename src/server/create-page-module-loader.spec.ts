import { describe, expect, it } from "vitest";
import { createPageModuleLoader } from "./create-page-module-loader";
import type { PageManifest } from "./page-manifest";

const appModule = { default: () => null };
const layoutModule = { default: () => null, prefix: "/" };
const pageModule = { default: () => null, route: "/" };

const manifest: PageManifest = {
  app: { module: appModule, sourceFile: "src/web/root.tsx" },
  pages: [
    {
      module: pageModule,
      sourceFile: "src/app/main/web/home.page.tsx",
      layouts: [{ module: layoutModule, sourceFile: "src/app/main/web/layout.tsx" }],
    },
  ],
};

describe("production page module loader", () => {
  it("resolves a page id to the namespace object the manifest carries for it", async () => {
    const loadModule = createPageModuleLoader(manifest);

    await expect(loadModule("src/app/main/web/home.page.tsx")).resolves.toBe(pageModule);
  });

  it("resolves a layout id from a page's layout chain", async () => {
    const loadModule = createPageModuleLoader(manifest);

    await expect(loadModule("src/app/main/web/layout.tsx")).resolves.toBe(layoutModule);
  });

  it("resolves the app id when the manifest has an app root", async () => {
    const loadModule = createPageModuleLoader(manifest);

    await expect(loadModule("src/web/root.tsx")).resolves.toBe(appModule);
  });

  it("throws and names the id it was asked for when the manifest has no such module", async () => {
    const loadModule = createPageModuleLoader(manifest);

    await expect(loadModule("src/app/main/web/missing.page.tsx")).rejects.toThrow(
      /src\/app\/main\/web\/missing\.page\.tsx/,
    );
  });

  it("matches ids exactly — a differently spelled path is unknown, not a near miss", async () => {
    const loadModule = createPageModuleLoader(manifest);

    await expect(loadModule("src\\app\\main\\web\\home.page.tsx")).rejects.toThrow();
    await expect(loadModule("src/app/main/web/home.page")).rejects.toThrow();
    await expect(loadModule("SRC/APP/MAIN/WEB/HOME.PAGE.TSX")).rejects.toThrow();
  });

  it("constructs from a manifest with no pages, and still refuses unknown ids", async () => {
    const loadModule = createPageModuleLoader({ pages: [] });

    await expect(loadModule("src/app/main/web/home.page.tsx")).rejects.toThrow(
      /src\/app\/main\/web\/home\.page\.tsx/,
    );
  });

  it("refuses the app id when the manifest has no app root", async () => {
    const loadModule = createPageModuleLoader({ pages: [] });

    await expect(loadModule("src/web/root.tsx")).rejects.toThrow(/src\/web\/root.tsx/);
  });

  it("rejects rather than throwing synchronously, so callers can await it uniformly", () => {
    const loadModule = createPageModuleLoader({ pages: [] });

    expect(() => loadModule("nope.tsx").catch(() => undefined)).not.toThrow();
  });
});
