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
import { publishLocaleRouting } from "../routing/locale-routing";
import { resolveSitemapConfig } from "./resolve-sitemap-config";

afterEach(() => {
  config.set("web", {});
  config.set("app", {});
  publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" });
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

// `de03cf18`: the app's real locale config lives at `app.localeCodes` /
// `app.localeCode` — the same keys `Request.cacheLocale()` reads
// (`core/src/http/request.ts`) and the same keys the scaffold declares.
// `web.sitemap.locales.codes` fell back to the wrong key (`app.locales`,
// which nothing else in the framework reads), so an app that never
// duplicated its locales under `web.sitemap.locales` got no hreflang
// alternates at all.
describe("resolveSitemapConfig — locales fall back to app.localeCodes / app.localeCode", () => {
  it("resolves codes and defaultLocale from app.localeCodes / app.localeCode when web.sitemap.locales is unset", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.codes).toEqual(["en", "ar"]);
    expect(resolved.locales.defaultLocale).toBe("en");
  });

  it("lets an explicit web.sitemap.locales.codes win over app.localeCodes", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    config.set("web", { sitemap: { locales: { codes: ["fr"] } } });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.codes).toEqual(["fr"]);
  });

  it("lets an explicit web.sitemap.locales.defaultLocale win over app.localeCode", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    config.set("web", { sitemap: { locales: { defaultLocale: "ar" } } });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.defaultLocale).toBe("ar");
  });

  it("resolves no codes and no defaultLocale when neither app nor web.sitemap declares locales", () => {
    const resolved = resolveSitemapConfig();

    expect(resolved.locales.codes).toEqual([]);
    expect(resolved.locales.defaultLocale).toBeUndefined();
  });
});

// Card D, design note §D.1: `web.localeRouting.strategy` folds a
// strategy-aware default into `web.sitemap.localeUrl` when the app never set
// its own — the default locale bare under "prefix-except-default", prefixed
// under "prefix" — and marks `localeRoutingActive` so `x-default` (computed
// in `expand-locale-entries.ts`) points at the default locale's own URL.
describe("resolveSitemapConfig — locale-routing-aware localeUrl default", () => {
  it("defaults localeUrl to the bare path for the default locale under prefix-except-default", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.localeUrl?.("/posts/x", "en")).toBe("/posts/x");
    expect(resolved.locales.localeUrl?.("/posts/x", "ar")).toBe("/ar/posts/x");
    expect(resolved.locales.localeRoutingActive).toBe(true);
  });

  it("prefixes every code, including the default, under prefix", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.localeUrl?.("/posts/x", "en")).toBe("/en/posts/x");
    expect(resolved.locales.localeUrl?.("/posts/x", "ar")).toBe("/ar/posts/x");
  });

  it("lets an explicit web.sitemap.localeUrl win over the strategy-aware default", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    config.set("web", {
      sitemap: { localeUrl: (path: string, code: string) => `${path}#${code}` },
    });
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.localeUrl?.("/posts/x", "ar")).toBe("/posts/x#ar");
  });

  it("leaves localeUrl undefined and localeRoutingActive false under strategy none", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    publishLocaleRouting({ strategy: "none", codes: ["en", "ar"], defaultLocale: "en" });

    const resolved = resolveSitemapConfig();

    expect(resolved.locales.localeUrl).toBeUndefined();
    expect(resolved.locales.localeRoutingActive).toBe(false);
  });
});
