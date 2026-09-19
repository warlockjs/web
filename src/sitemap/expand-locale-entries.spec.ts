import { describe, expect, it } from "vitest";
import { expandLocaleEntries, localeInvariantEntry } from "./expand-locale-entries";

describe("expandLocaleEntries", () => {
  it("emits a single alternate-free entry when no locales are configured", () => {
    const result = expandLocaleEntries({ path: "/about" }, undefined, { codes: [] });

    expect(result).toEqual([{ entry: { path: "/about" } }]);
  });

  it("produces one primary <url> per locale, defaulting to `path?locale=<code>`, each with the complete reciprocal alternate set", () => {
    const result = expandLocaleEntries({ path: "/about" }, undefined, {
      codes: ["en", "ar"],
    });

    expect(result).toHaveLength(2);

    const alternates = [
      { hreflang: "en", path: "/about?locale=en" },
      { hreflang: "ar", path: "/about?locale=ar" },
    ];

    expect(result[0]).toEqual({
      localeCode: "en",
      entry: { path: "/about?locale=en", alternates },
    });
    expect(result[1]).toEqual({
      localeCode: "ar",
      entry: { path: "/about?locale=ar", alternates },
    });
  });

  it("appends the locale as `&locale=<code>` when the path already carries a query string", () => {
    const result = expandLocaleEntries({ path: "/search?q=shoes" }, undefined, {
      codes: ["en", "ar"],
    });

    expect(result.map((item) => item.entry.path)).toEqual([
      "/search?q=shoes&locale=en",
      "/search?q=shoes&locale=ar",
    ]);
  });

  it("encodes the locale code in the default query form", () => {
    const result = expandLocaleEntries({ path: "/about" }, undefined, {
      codes: ["pt-BR"],
    });

    expect(result[0]?.entry.path).toBe("/about?locale=pt-BR");
  });

  it("adds an x-default alternate pointing at the page's bare path", () => {
    const result = expandLocaleEntries({ path: "/about" }, undefined, {
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const expectedAlternates = [
      { hreflang: "en", path: "/about?locale=en" },
      { hreflang: "ar", path: "/about?locale=ar" },
      { hreflang: "x-default", path: "/about" },
    ];

    expect(result[0]?.entry.alternates).toEqual(expectedAlternates);
    expect(result[1]?.entry.alternates).toEqual(expectedAlternates);
  });

  it("uses a page's own localePaths for a divergent slug instead of deriving one", () => {
    const result = expandLocaleEntries(
      { path: "/posts/hello-world", localePaths: { ar: "/posts/مرحبا" } },
      "/posts/:id",
      { codes: ["en", "ar"] },
    );

    expect(result[0]?.entry.path).toBe("/posts/hello-world?locale=en");
    expect(result[1]?.entry.path).toBe("/posts/مرحبا");
    expect(result[0]?.entry.alternates).toEqual([
      { hreflang: "en", path: "/posts/hello-world?locale=en" },
      { hreflang: "ar", path: "/posts/مرحبا" },
    ]);
    expect(result[0]?.entry.route).toBe("/posts/:id");
  });

  it("replaces the default query-form URL with the app's `localeUrl` hook when configured", () => {
    const result = expandLocaleEntries({ path: "/about" }, undefined, {
      codes: ["en", "ar"],
      localeUrl: (path, code) => `/${code}${path}`,
    });

    expect(result.map((item) => item.entry.path)).toEqual(["/en/about", "/ar/about"]);
    expect(result[0]?.entry.alternates).toEqual([
      { hreflang: "en", path: "/en/about" },
      { hreflang: "ar", path: "/ar/about" },
    ]);
  });

  it("still prefers a page's own localePaths over the app's `localeUrl` hook", () => {
    const result = expandLocaleEntries(
      { path: "/about", localePaths: { ar: "/about-ar" } },
      undefined,
      { codes: ["en", "ar"], localeUrl: (path, code) => `/${code}${path}` },
    );

    expect(result.map((item) => item.entry.path)).toEqual(["/en/about", "/about-ar"]);
  });

  it("every locale's alternate set includes itself (the reciprocity rule, contract 5(d))", () => {
    const result = expandLocaleEntries({ path: "/about" }, undefined, {
      codes: ["en", "ar", "fr"],
    });

    for (const item of result) {
      const hreflangs = item.entry.alternates?.map((alternate) => alternate.hreflang);
      expect(hreflangs).toEqual(expect.arrayContaining(["en", "ar", "fr"]));
    }
  });
});

// Card D, design note §D.1.
describe("expandLocaleEntries — localeRoutingActive (an active web.localeRouting.strategy)", () => {
  it("points x-default at the default locale's OWN resolved URL, not the bare path", () => {
    const result = expandLocaleEntries({ path: "/posts/x" }, undefined, {
      codes: ["en", "ar"],
      defaultLocale: "en",
      // Mirrors what `resolveSitemapConfig()` folds in under "prefix": every
      // code, including the default, is prefixed.
      localeUrl: (path, code) => `/${code}${path}`,
      localeRoutingActive: true,
    });

    const alternates = result[0]?.entry.alternates;

    expect(alternates).toEqual([
      { hreflang: "en", path: "/en/posts/x" },
      { hreflang: "ar", path: "/ar/posts/x" },
      { hreflang: "x-default", path: "/en/posts/x" },
    ]);
  });

  it("still keeps x-default at the bare path when localeRoutingActive is unset (today's behaviour)", () => {
    const result = expandLocaleEntries({ path: "/posts/x" }, undefined, {
      codes: ["en", "ar"],
      defaultLocale: "en",
      localeUrl: (path, code) => `/${code}${path}`,
    });

    expect(result[0]?.entry.alternates).toContainEqual({
      hreflang: "x-default",
      path: "/posts/x",
    });
  });
});

// Card D, design note §D.1's last bullet: `[locale]`-folder pages (card C).
describe("expandLocaleEntries — a page whose path carries the :locale param", () => {
  it("substitutes each code into :locale, and x-default takes the default locale's substitution", () => {
    const result = expandLocaleEntries(
      { path: "/:locale/posts/hello-world" },
      "/:locale/posts/:slug",
      { codes: ["en", "ar"], defaultLocale: "en" },
    );

    expect(result.map((item) => item.entry.path)).toEqual([
      "/en/posts/hello-world",
      "/ar/posts/hello-world",
    ]);
    expect(result[0]?.entry.alternates).toEqual([
      { hreflang: "en", path: "/en/posts/hello-world" },
      { hreflang: "ar", path: "/ar/posts/hello-world" },
      { hreflang: "x-default", path: "/en/posts/hello-world" },
    ]);
  });

  it("still prefers a page's own localePaths for a divergent slug over the substitution", () => {
    const result = expandLocaleEntries(
      { path: "/:locale/about", localePaths: { ar: "/:locale/about-ar" } },
      "/:locale/about",
      { codes: ["en", "ar"] },
    );

    expect(result.map((item) => item.entry.path)).toEqual(["/en/about", "/:locale/about-ar"]);
  });
});

describe("localeInvariantEntry", () => {
  it("produces one entry with zero alternates at the page's own path", () => {
    const result = localeInvariantEntry({ path: "/privacy" }, undefined);

    expect(result).toEqual({ entry: { path: "/privacy" } });
  });
});
