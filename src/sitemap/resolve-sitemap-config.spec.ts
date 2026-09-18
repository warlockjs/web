/**
 * `de97020e`: `SitemapIndex.saveTo(outputDir)` swaps the whole directory it
 * is given (`@warlock.js/sitemap`'s `publishAtomically`). The default here
 * must never resolve to the app's public directory, or a successful
 * generation deletes every unrelated public asset.
 */
import config from "@mongez/config";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicPath, storagePath } from "@warlock.js/core";
import { resolveSitemapConfig } from "./resolve-sitemap-config";

afterEach(() => {
  config.set("web", {});
});

describe("resolveSitemapConfig — outputDir default", () => {
  it("does not default to publicPath()", () => {
    const resolved = resolveSitemapConfig();

    expect(resolved.outputDir).not.toBe(publicPath());
  });

  it("does not default to a path inside publicPath()", () => {
    const resolved = resolveSitemapConfig();
    const relative = path.relative(publicPath(), resolved.outputDir);

    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);
  });

  it("defaults to a dedicated directory under storagePath()", () => {
    const resolved = resolveSitemapConfig();

    expect(resolved.outputDir).toBe(storagePath("sitemap"));
  });

  it("still honours an explicit outputDir override", () => {
    config.set("web", { sitemap: { outputDir: "/explicit/dir" } });

    const resolved = resolveSitemapConfig();

    expect(resolved.outputDir).toBe("/explicit/dir");
  });
});
