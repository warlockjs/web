import config from "@mongez/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSitemap } from "./generate-sitemap";
import { MissingPublicUrlError } from "./errors";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-generate-sitemap-"));
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

  config.set("app", {});
  config.set("web", {});
});

describe("generateSitemap", () => {
  it("does nothing and writes no output when web.sitemap.enabled is unset (default disabled)", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    config.set("app", {});
    config.set("web", { sitemap: { outputDir: path.join(appRoot, "storage", "sitemap") } });

    const result = await generateSitemap({ appRoot });

    expect(result).toEqual({ mode: "disabled", urls: 0, duplicates: [], routes: [] });
    expect(fs.existsSync(path.join(appRoot, "storage", "sitemap", "sitemap.xml"))).toBe(false);
  });

  it("refuses when enabled and app.publicUrl is unset", async () => {
    const appRoot = makeAppTree({});

    config.set("app", {});
    config.set("web", {
      sitemap: { enabled: true, outputDir: path.join(appRoot, "storage", "sitemap") },
    });

    await expect(generateSitemap({ appRoot })).rejects.toBeInstanceOf(MissingPublicUrlError);
  });

  it("writes a bounded sitemap.xml for a plain site", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    config.set("app", { publicUrl: "https://example.test" });
    config.set("web", {
      sitemap: { enabled: true, outputDir: path.join(appRoot, "storage", "sitemap") },
    });

    const result = await generateSitemap({ appRoot });

    expect(result).toMatchObject({ mode: "single", urls: 1 });
    const xml = fs.readFileSync(path.join(appRoot, "storage", "sitemap", "sitemap.xml"), "utf-8");
    expect(xml).toContain("https://example.test/about");
  });

  it("reports a dynamic page with no supplier as a zero-count route", async () => {
    const appRoot = makeAppTree({
      "src/web/products/[slug].page.tsx": ["export default function Page() { return null; }"].join(
        "\n",
      ),
    });

    config.set("app", { publicUrl: "https://example.test" });
    config.set("web", {
      sitemap: { enabled: true, outputDir: path.join(appRoot, "storage", "sitemap") },
    });

    const result = await generateSitemap({ appRoot });

    expect(result.routes).toEqual([{ route: "/products/:slug", count: 0 }]);
  });

  it("splits by locale into a SitemapIndex with one source per locale", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    config.set("app", { publicUrl: "https://example.test", localeCodes: ["en", "ar"] });
    config.set("web", {
      sitemap: {
        enabled: true,
        outputDir: path.join(appRoot, "storage", "sitemap"),
        locales: { splitByLocale: true },
      },
    });

    const result = await generateSitemap({ appRoot });

    expect("indexPath" in result).toBe(true);
    if (!("indexPath" in result)) throw new Error("expected index mode");

    expect(fs.existsSync(result.indexPath)).toBe(true);
    const keys = result.files.filter((file) => file.urls > 0).map((file) => file.key);
    expect(keys.sort()).toEqual(["ar", "en"]);
  });

  it("switches from a single file to per-locale files in the same output directory", async () => {
    // The framework must not refuse its own earlier output when a site turns
    // on splitByLocale (or grows past one file) after a single-file publish.
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });
    const outputDir = path.join(appRoot, "storage", "sitemap");

    config.set("app", { publicUrl: "https://example.test", localeCodes: ["en", "ar"] });
    config.set("web", { sitemap: { enabled: true, outputDir } });

    const single = await generateSitemap({ appRoot });
    expect("indexPath" in single).toBe(false);

    config.set("web", {
      sitemap: { enabled: true, outputDir, locales: { splitByLocale: true } },
    });

    const split = await generateSitemap({ appRoot });
    expect("indexPath" in split).toBe(true);
  });

  it("picks up app.localeCodes / app.localeCode with no web.sitemap.locales override, and emits en/ar alternates", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    config.set("app", {
      publicUrl: "https://example.test",
      localeCodes: ["en", "ar"],
      localeCode: "en",
    });
    config.set("web", {
      sitemap: { enabled: true, outputDir: path.join(appRoot, "storage", "sitemap") },
    });

    const result = await generateSitemap({ appRoot });

    expect(result).toMatchObject({ mode: "single" });
    const xml = fs.readFileSync(path.join(appRoot, "storage", "sitemap", "sitemap.xml"), "utf-8");

    expect(xml).toContain('hreflang="en"');
    expect(xml).toContain('hreflang="ar"');
    expect(xml).toContain('hreflang="x-default"');
    expect(xml).toContain("locale=en");
    expect(xml).toContain("locale=ar");
  });
});
