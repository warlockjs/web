/**
 * Red-first (v5.16 production-manifest ruling): a production-shaped page
 * manifest — in-memory module objects only — must produce the same sitemap
 * entries `collectSitemapEntries` derives from `listRoutablePages` in dev,
 * WITHOUT importing any file. `createManifestSitemapPageSource` builds that
 * source; `collectSitemapEntries` uses it whenever one is registered
 * (`./production-sitemap-page-source.ts`) or passed explicitly.
 */
import { describe, expect, it, vi } from "vitest";
import { collectSitemapEntries } from "./collect-sitemap-entries";
import { createManifestSitemapPageSource } from "./manifest-sitemap-page-source";
import {
  resetProductionSitemapPageSourceForTests,
  setProductionSitemapPageSource,
} from "./production-sitemap-page-source";
import type { PageManifest } from "../server/page-manifest";

const noLocales = { codes: [] as string[] };

function pageEntry(sourceFile: string, module: Record<string, unknown>) {
  return { module, sourceFile, layouts: [] };
}

describe("createManifestSitemapPageSource", () => {
  it("derives entries from an in-memory manifest, including a dynamic supplier and an opted-out page, without listRoutablePages", async () => {
    const manifest: PageManifest = {
      pages: [
        pageEntry("src/web/about.page.tsx", {
          route: "/about",
          default: () => null,
        }),
        pageEntry("src/web/posts/[id].page.tsx", {
          sitemap: async () => [{ path: "/posts/hello-world" }],
          default: () => null,
        }),
        pageEntry("src/web/draft.page.tsx", {
          sitemap: false,
          default: () => null,
        }),
        pageEntry("src/web/404.page.tsx", {
          default: () => null,
        }),
      ],
    };

    const source = createManifestSitemapPageSource(manifest);
    const entries = await source();

    expect(entries).toEqual([
      { routeName: "about", routePath: "/about", metadata: undefined, sitemap: undefined },
      {
        routeName: "posts.id",
        routePath: "/posts/:id",
        metadata: undefined,
        sitemap: (manifest.pages[1].module as { sitemap: unknown }).sitemap,
      },
      { routeName: "draft", routePath: "/draft", metadata: undefined, sitemap: false },
    ]);
  });

  it("is what collectSitemapEntries uses in production instead of listRoutablePages — proven by a watched red control", async () => {
    const manifest: PageManifest = {
      pages: [pageEntry("src/web/about.page.tsx", { route: "/about", default: () => null })],
    };

    setProductionSitemapPageSource(createManifestSitemapPageSource(manifest));

    try {
      // No `appRoot` page tree exists on disk at all — this only succeeds if
      // the registered manifest source is used instead of `listRoutablePages`
      // falling through to a filesystem walk.
      const { items } = await collectSitemapEntries({
        appRoot: "/does/not/exist",
        locales: noLocales,
      });

      expect(items).toEqual([{ entry: { path: "/about" } }]);
    } finally {
      resetProductionSitemapPageSourceForTests();
    }
  });
});
