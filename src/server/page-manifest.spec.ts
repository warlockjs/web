import { describe, expect, it, vi } from "vitest";
import type { PageManifest } from "./page-manifest";

const manifest: PageManifest = {
  app: { module: {}, sourceFile: "src/web/root.tsx" },
  pages: [
    {
      module: { route: "/" },
      sourceFile: "src/app/main/web/home.page.tsx",
      layouts: [{ module: { prefix: "/" }, sourceFile: "src/app/main/web/layout.tsx" }],
    },
  ],
};

/**
 * A pristine registry per test. The registry holds ONE module-level slot that
 * may be filled once per process, so isolation has to come from a fresh module
 * instance — the module deliberately ships no resetter, since a public one
 * would be a way around the once-only rule it exists to enforce.
 */
async function freshRegistry() {
  vi.resetModules();

  return import("./page-manifest");
}

describe("page manifest registry", () => {
  it("reads back undefined before any barrel ran — absence is a fact, not an error", async () => {
    const { consumePageManifest } = await freshRegistry();

    expect(consumePageManifest()).toBeUndefined();
  });

  it("hands back the exact manifest the barrel provided", async () => {
    const { consumePageManifest, providePageManifest } = await freshRegistry();

    providePageManifest(manifest);

    expect(consumePageManifest()).toBe(manifest);
  });

  it("throws on a second provide rather than letting one table replace the other", async () => {
    const { providePageManifest } = await freshRegistry();

    providePageManifest(manifest);

    expect(() => providePageManifest(manifest)).toThrowError(/already provided/);
  });

  it("accepts the empty manifest a page-free build provides — no app entry required", async () => {
    const { consumePageManifest, providePageManifest } = await freshRegistry();
    const empty: PageManifest = { pages: [] };

    providePageManifest(empty);

    const read = consumePageManifest();

    expect(read).toBe(empty);
    expect(read?.pages).toHaveLength(0);
    expect(read?.app).toBeUndefined();
    // Built-with-web-and-empty must stay distinguishable from never-built.
    expect(read).not.toBeUndefined();
  });

  it("holds the once-only rule for the empty manifest too", async () => {
    const { providePageManifest } = await freshRegistry();

    providePageManifest({ pages: [] });

    expect(() => providePageManifest({ pages: [] })).toThrowError(/already provided/);
  });

  it("keeps the first manifest after a rejected second provide", async () => {
    const { consumePageManifest, providePageManifest } = await freshRegistry();

    providePageManifest(manifest);

    const second: PageManifest = { app: { module: {}, sourceFile: "other.tsx" }, pages: [] };

    expect(() => providePageManifest(second)).toThrow();
    expect(consumePageManifest()).toBe(manifest);
  });
});
