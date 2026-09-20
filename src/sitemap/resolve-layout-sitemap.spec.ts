import { describe, expect, it } from "vitest";

import { SitemapLayoutDeclarationError } from "./errors";
import { resolveSitemapDeclaration } from "./resolve-layout-sitemap";

/**
 * The precedence rule, exercised directly. It lives in one function so dev and
 * production cannot disagree about a sitemap, and this is where that function
 * is held to the contract (`contracts/layout-sitemap-and-robots-5.17.md`).
 *
 * Layout chains here are OUTERMOST FIRST, matching the chain `discoverPages`
 * builds — so the last entry is the nearest ancestor.
 */
const layout = (sourceFile: string, declared: unknown) => ({ sourceFile, declared });

describe("resolveSitemapDeclaration — inheritance", () => {
  it("returns nothing when neither the page nor any layout declared — today's behaviour, unchanged", () => {
    expect(resolveSitemapDeclaration(undefined, [])).toBeUndefined();
    expect(
      resolveSitemapDeclaration(undefined, [layout("src/web/layout.tsx", undefined)]),
    ).toBeUndefined();
  });

  it("inherits a layout's `false` — the whole subtree is out", () => {
    expect(resolveSitemapDeclaration(undefined, [layout("src/web/admin/layout.tsx", false)])).toBe(
      false,
    );
  });

  it("inherits a layout's options object", () => {
    expect(
      resolveSitemapDeclaration(undefined, [
        layout("src/web/docs/layout.tsx", { changefreq: "weekly", priority: 0.5 }),
      ]),
    ).toEqual({ changefreq: "weekly", priority: 0.5 });
  });

  it("takes the NEAREST ancestor when two layouts declare", () => {
    expect(
      resolveSitemapDeclaration(undefined, [
        layout("src/web/layout.tsx", { priority: 0.1 }),
        layout("src/web/docs/layout.tsx", { priority: 0.9 }),
      ]),
    ).toEqual({ priority: 0.9 });
  });

  it("skips an ancestor that declared nothing when finding the nearest", () => {
    expect(
      resolveSitemapDeclaration(undefined, [
        layout("src/web/layout.tsx", { priority: 0.1 }),
        layout("src/web/docs/layout.tsx", undefined),
      ]),
    ).toEqual({ priority: 0.1 });
  });
});

describe("resolveSitemapDeclaration — a page beats every layout, WHOLESALE", () => {
  it("uses the page's declaration instead of the layout's", () => {
    expect(
      resolveSitemapDeclaration({ priority: 0.9 }, [
        layout("src/web/docs/layout.tsx", { priority: 0.1 }),
      ]),
    ).toEqual({ priority: 0.9 });
  });

  it("does NOT merge the layout's other keys into the page's object", () => {
    // The whole argument for wholesale override. A merged result would be
    // { priority: 0.9, changefreq: "weekly" } — a value no single file states,
    // so "where did changefreq come from?" would have a derivation for an
    // answer instead of a filename.
    expect(
      resolveSitemapDeclaration({ priority: 0.9 }, [
        layout("src/web/docs/layout.tsx", { changefreq: "weekly", priority: 0.1 }),
      ]),
    ).toEqual({ priority: 0.9 });
  });

  it("lets a page opt back IN under a layout that excluded the subtree", () => {
    expect(
      resolveSitemapDeclaration({ priority: 0.5 }, [layout("src/web/admin/layout.tsx", false)]),
    ).toEqual({ priority: 0.5 });
  });

  it("lets a page opt OUT under a layout that supplied defaults", () => {
    expect(
      resolveSitemapDeclaration(false, [layout("src/web/docs/layout.tsx", { priority: 0.9 })]),
    ).toBe(false);
  });

  it("keeps a page's URL supplier untouched — the form a layout may not use", () => {
    const supplier = () => [];

    expect(resolveSitemapDeclaration(supplier, [layout("src/web/layout.tsx", false)])).toBe(
      supplier,
    );
  });
});

describe("resolveSitemapDeclaration — what a layout may NOT declare", () => {
  it("refuses a URL supplier on a layout, naming the file and where suppliers belong", () => {
    expect(() =>
      resolveSitemapDeclaration(undefined, [layout("src/web/shop/layout.tsx", () => [])]),
    ).toThrow(SitemapLayoutDeclarationError);

    try {
      resolveSitemapDeclaration(undefined, [layout("src/web/shop/layout.tsx", () => [])]);
      expect.unreachable("the supplier should have been refused");
    } catch (error) {
      const message = (error as Error).message;

      // Naming the file is the difference between a developer fixing this in a
      // minute and hunting for it.
      expect(message).toContain("src/web/shop/layout.tsx");
      expect(message).toContain("belongs on a page");
    }
  });

  it("refuses `true`, which would be a setting with no behaviour", () => {
    expect(() =>
      resolveSitemapDeclaration(undefined, [layout("src/web/layout.tsx", true)]),
    ).toThrow(/`true`/);
  });

  it("refuses an unknown option key BY NAME, and lists the valid ones", () => {
    try {
      resolveSitemapDeclaration(undefined, [
        layout("src/web/layout.tsx", { images: true, priority: 0.5 }),
      ]);
      expect.unreachable("the unknown key should have been refused");
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain("`images`");
      expect(message).toContain("priority");
      expect(message).toContain("changefreq");
    }
  });

  it("accepts every key the PAGE contract allows — one list, so a layout cannot reject what a page accepts", () => {
    const everyKey = {
      priority: 0.5,
      changefreq: "weekly",
      lastmod: "2026-09-20",
      locales: false,
      localePaths: { ar: "/ar/x" },
    };

    expect(resolveSitemapDeclaration(undefined, [layout("src/web/layout.tsx", everyKey)])).toEqual(
      everyKey,
    );
  });

  it("refuses an array, which is neither `false` nor an options object", () => {
    expect(() => resolveSitemapDeclaration(undefined, [layout("src/web/layout.tsx", [])])).toThrow(
      /an array/,
    );
  });

  it("does NOT validate the PAGE's declaration — that is the page contract's job, not this one's", () => {
    // A page may legitimately carry shapes this module would refuse on a
    // layout. Validating it here would be a second rule for one export.
    expect(resolveSitemapDeclaration({ anything: true }, [])).toEqual({ anything: true });
  });
});
