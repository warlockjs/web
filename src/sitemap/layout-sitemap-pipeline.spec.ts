/**
 * The integration boundary for layout sitemap policy: dev reads a real page
 * tree through `listRoutablePages`, production reads the equivalent already
 * loaded manifest, and both go through the collector into published XML.
 */
import config from "@mongez/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSitemapEntries } from "./collect-sitemap-entries";
import { generateSitemap } from "./generate-sitemap";
import { createManifestSitemapPageSource } from "./manifest-sitemap-page-source";
import type { PageManifest } from "../server/page-manifest";

const temporaryDirectories: string[] = [];
const locales = {
  codes: ["en", "ar"],
  defaultLocale: "en",
  localeUrl: (pagePath: string, code: string) => `/${code}${pagePath}`,
};

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-layout-sitemap-pipeline-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }

  return appRoot;
}

function page(sourceFile: string, module: Record<string, unknown>, layouts = [] as const) {
  return { sourceFile, module, layouts };
}

function policyManifest(): PageManifest {
  const excluded = { sitemap: false };
  const outer = { sitemap: { priority: 0.1, changefreq: "weekly" } };
  const nearest = { sitemap: { priority: 0.7 }, default: () => null };

  return {
    pages: [
      page("src/web/guides/api/reference.page.tsx", { default: () => null }, [
        { sourceFile: "src/web/guides/layout.tsx", module: outer },
        { sourceFile: "src/web/guides/api/layout.tsx", module: nearest },
      ]),
      page("src/web/policy/hidden.page.tsx", { default: () => null }, [
        { sourceFile: "src/web/policy/layout.tsx", module: excluded },
      ]),
      page("src/web/policy/opt-in.page.tsx", { sitemap: { priority: 0.9 }, default: () => null }, [
        { sourceFile: "src/web/policy/layout.tsx", module: excluded },
      ]),
    ],
  } as PageManifest;
}

function policyTree(): Record<string, string> {
  return {
    "src/web/policy/layout.tsx": "export const sitemap = false;",
    "src/web/policy/hidden.page.tsx": "export default function Page() { return null; }",
    "src/web/policy/opt-in.page.tsx": [
      "export const sitemap = { priority: 0.9 };",
      "export default function Page() { return null; }",
    ].join("\n"),
    "src/web/guides/layout.tsx": 'export const sitemap = { priority: 0.1, changefreq: "weekly" };',
    "src/web/guides/api/layout.tsx": [
      "export const sitemap = { priority: 0.7 };",
      "export default function Layout() { return null; }",
    ].join("\n"),
    "src/web/guides/api/reference.page.tsx": "export default function Page() { return null; }",
  };
}

function urlBlock(xml: string, url: string): string {
  const match = xml.match(
    new RegExp(`<url>(?:(?!</url>)[\\s\\S])*<loc>${url}</loc>(?:(?!</url>)[\\s\\S])*</url>`),
  );
  expect(match, `missing URL block for ${url}`).not.toBeNull();
  return match?.[0] ?? "";
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  config.set("app", {});
  config.set("web", {});
});

describe("layout sitemap pipeline", () => {
  it("publishes identical inherited policy XML from the real dev tree and equivalent production manifest", async () => {
    const appRoot = makeAppTree(policyTree());
    const devOutput = path.join(appRoot, "dev-sitemap");
    const productionOutput = path.join(appRoot, "production-sitemap");

    // Dev intentionally has no pageSource: this is the real source-file import
    // seam in listRoutablePages, not a Vite server or a pre-resolved fixture.
    const devCollected = await collectSitemapEntries({ appRoot, locales });
    const productionCollected = await collectSitemapEntries({
      appRoot,
      locales,
      pageSource: createManifestSitemapPageSource(policyManifest()),
    });

    expect(devCollected).toEqual(productionCollected);
    expect(devCollected.items).toHaveLength(4);
    expect(devCollected.items.map(({ entry }) => entry.path)).toEqual([
      "/en/guides/api/reference",
      "/ar/guides/api/reference",
      "/en/policy/opt-in",
      "/ar/policy/opt-in",
    ]);

    config.set("app", {
      publicUrl: "https://example.test",
      localeCodes: ["en", "ar"],
      localeCode: "en",
    });
    config.set("web", {
      sitemap: { enabled: true, outputDir: devOutput, localeUrl: locales.localeUrl },
    });
    await generateSitemap({ appRoot });

    config.set("web", {
      sitemap: { enabled: true, outputDir: productionOutput, localeUrl: locales.localeUrl },
    });
    await generateSitemap({
      appRoot,
      pageSource: createManifestSitemapPageSource(policyManifest()),
    });

    const devXml = fs.readFileSync(path.join(devOutput, "sitemap.xml"), "utf8");
    const productionXml = fs.readFileSync(path.join(productionOutput, "sitemap.xml"), "utf8");
    expect(productionXml).toBe(devXml);
    expect(devXml).not.toContain("/policy/hidden");

    const optIn = urlBlock(devXml, "https://example.test/en/policy/opt-in");
    expect(optIn).toContain("<priority>0.9</priority>");
    const nearest = urlBlock(devXml, "https://example.test/en/guides/api/reference");
    expect(nearest).toContain("<priority>0.7</priority>");
    expect(nearest).not.toContain("weekly"); // nearest wins wholesale; layout options never merge.
    expect(devXml).toContain("https://example.test/ar/guides/api/reference");
    expect(devXml).toContain('hreflang="en"');
    expect(devXml).toContain('hreflang="ar"');
  });

  it.each([
    ["a supplier", 'async () => [{ path: "/ignored" }]', async () => [{ path: "/ignored" }]],
    ["an unknown option", "{ unsupported: true }", { unsupported: true }],
    ["an invalid option value", "{ priority: 2 }", { priority: 2 }],
  ])(
    "rejects a layout with %s even when its page explicitly overrides it",
    async (_kind, sourceDeclaration, manifestDeclaration) => {
      const appRoot = makeAppTree({
        "src/web/bad/layout.tsx": `export const sitemap = ${sourceDeclaration};`,
        "src/web/bad/child.page.tsx": [
          "export const sitemap = { priority: 0.8 };",
          "export default function Page() { return null; }",
        ].join("\n"),
      });
      const layoutFile = path.join(appRoot, "src/web/bad/layout.tsx");
      const manifest: PageManifest = {
        pages: [
          page("src/web/bad/child.page.tsx", { sitemap: { priority: 0.8 }, default: () => null }, [
            { sourceFile: "src/web/bad/layout.tsx", module: { sitemap: manifestDeclaration } },
          ]),
        ],
      } as PageManifest;

      for (const source of [undefined, createManifestSitemapPageSource(manifest)]) {
        await expect(
          collectSitemapEntries({ appRoot, locales: { codes: [] }, pageSource: source }),
        ).rejects.toMatchObject({ sourceFile: source ? "src/web/bad/layout.tsx" : layoutFile });
      }
    },
  );
});
