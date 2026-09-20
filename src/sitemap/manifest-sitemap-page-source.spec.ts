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

    // `layoutSitemaps` carries what each LAYOUT on the page's path declared,
    // so the precedence rule can be applied in one place by
    // `collectSitemapEntries` rather than separately by each page source.
    // Empty here because every fixture page above has an empty layout chain.
    expect(entries).toEqual([
      {
        routeName: "about",
        routePath: "/about",
        metadata: undefined,
        sitemap: undefined,
        layoutSitemaps: [],
      },
      {
        routeName: "posts.id",
        routePath: "/posts/:id",
        metadata: undefined,
        sitemap: (manifest.pages[1].module as { sitemap: unknown }).sitemap,
        layoutSitemaps: [],
      },
      {
        routeName: "draft",
        routePath: "/draft",
        metadata: undefined,
        sitemap: false,
        layoutSitemaps: [],
      },
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

/**
 * The PRODUCTION half of layout sitemap inheritance
 * (`contracts/layout-sitemap-and-robots-5.17.md`).
 *
 * Added after the full-suite run caught the field being missing from this
 * file's expectations — and updating an expectation to absorb a new field
 * proves only that the field exists. This proves it carries the layout's
 * actual declaration, which is the part production depends on and the part
 * that could silently read `undefined` forever without anyone noticing.
 */
describe("createManifestSitemapPageSource — layout declarations", () => {
  it("carries each layout's `sitemap` export, outermost first, off the modules the manifest already holds", async () => {
    // The outer layout renders NOTHING — a prefix-only layout. Two rendering
    // layouts on one path are refused (NestedLayoutsNotSupportedError), and
    // that refusal is what makes this case worth having: it proves a
    // non-rendering ancestor's declaration is still carried, which is exactly
    // the ancestor the request pipeline cannot see today.
    const outerLayout = { prefix: "/docs", sitemap: { priority: 0.2 } };
    const innerLayout = { sitemap: false, default: () => null };

    const manifest: PageManifest = {
      pages: [
        {
          module: { route: "/docs/api", default: () => null },
          sourceFile: "src/web/docs/api.page.tsx",
          layouts: [
            { module: outerLayout, sourceFile: "src/web/docs/layout.tsx" },
            { module: innerLayout, sourceFile: "src/web/docs/api/layout.tsx" },
          ],
        },
      ],
    } as unknown as PageManifest;

    const [entry] = await createManifestSitemapPageSource(manifest)();

    expect(entry?.layoutSitemaps).toEqual([
      { sourceFile: "src/web/docs/layout.tsx", declared: { priority: 0.2 } },
      { sourceFile: "src/web/docs/api/layout.tsx", declared: false },
    ]);
  });

  it("reports a layout that declared nothing as `undefined` rather than omitting it", async () => {
    // Order is load-bearing: the precedence rule takes the LAST declaration,
    // so a silent layout must still occupy its position in the chain.
    const manifest: PageManifest = {
      pages: [
        {
          module: { route: "/x", default: () => null },
          sourceFile: "src/web/x.page.tsx",
          layouts: [
            { module: { default: () => null }, sourceFile: "src/web/layout.tsx" },
            { module: { sitemap: false }, sourceFile: "src/web/deep/layout.tsx" },
          ],
        },
      ],
    } as unknown as PageManifest;

    const [entry] = await createManifestSitemapPageSource(manifest)();

    expect(entry?.layoutSitemaps).toEqual([
      { sourceFile: "src/web/layout.tsx", declared: undefined },
      { sourceFile: "src/web/deep/layout.tsx", declared: false },
    ]);
  });
});
