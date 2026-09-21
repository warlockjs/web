import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSitemapEntries } from "./collect-sitemap-entries";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-collect-sitemap-entries-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

const noLocales = { codes: [] as string[] };

describe("collectSitemapEntries", () => {
  it("collects a plain static page as one entry", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const config = { route: "/about" };',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items, declaredRoutes } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(items).toEqual([{ entry: { path: "/about" } }]);
    expect(declaredRoutes.size).toBe(0);
  });

  it("excludes a page that opts out with `config.sitemap = false`", async () => {
    const appRoot = makeAppTree({
      "src/web/draft.page.tsx": [
        "export const config = { sitemap: false };",
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items, declaredRoutes } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(items).toEqual([]);
    expect(declaredRoutes.size).toBe(0);
  });

  it("calls a dynamic page's supplier and reports the pattern it contributed to", async () => {
    const appRoot = makeAppTree({
      "src/web/posts/[id].page.tsx": [
        'export const config = { sitemap: async () => [{ path: "/posts/hello-world" }, { path: "/posts/second" }] };',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items, declaredRoutes } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(items.map((item) => item.entry.path)).toEqual(["/posts/hello-world", "/posts/second"]);
    expect(items.every((item) => item.entry.route === "/posts/:id")).toBe(true);
    expect(declaredRoutes).toEqual(new Set(["/posts/:id"]));
  });

  it("contributes nothing for a dynamic page with no supplier, but still declares the pattern", async () => {
    const appRoot = makeAppTree({
      "src/web/products/[slug].page.tsx": ["export default function Page() { return null; }"].join(
        "\n",
      ),
    });

    const { items, declaredRoutes } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(items).toEqual([]);
    expect(declaredRoutes).toEqual(new Set(["/products/:slug"]));
  });

  it("treats `locales: false` as locale-invariant: one entry, no alternates, even with locales configured", async () => {
    const appRoot = makeAppTree({
      "src/web/privacy.page.tsx": [
        "export const config = { sitemap: { locales: false } };",
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items } = await collectSitemapEntries({
      appRoot,
      locales: { codes: ["en", "ar"] },
    });

    expect(items).toEqual([{ entry: { path: "/privacy" } }]);
  });

  it("expands a static page across configured locales with per-page localePaths for divergent slugs", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const config = { route: "/about", sitemap: { localePaths: { ar: "/about-ar" } } };',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items } = await collectSitemapEntries({
      appRoot,
      locales: { codes: ["en", "ar"] },
    });

    expect(items.map((item) => item.entry.path)).toEqual(["/about?locale=en", "/about-ar"]);
  });

  it("does not declare an opted-out page's pattern", async () => {
    const appRoot = makeAppTree({
      "src/web/drafts/[id].page.tsx": [
        "export const config = { sitemap: false };",
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { declaredRoutes } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(declaredRoutes.size).toBe(0);
  });
});
