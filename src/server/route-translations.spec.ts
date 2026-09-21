import { describe, expect, it } from "vitest";

import type { RouteLocaleManifest } from "../build/build-route-locale-manifest";
import { createRouteTranslationsResolver } from "./route-translations";

const source = "/app/src/web/account/page.page.tsx";
const sibling = "/app/src/web/catalog/page.page.tsx";

function manifest(): RouteLocaleManifest {
  return {
    localeCodes: ["en", "ar"],
    localeCode: "en",
    sources: [],
    keys: ["account.title", "catalog.title"],
    pages: {
      [source]: {
        sourceFiles: ["/app/src/web/locales.json"],
        translationsByLocale: {
          en: { account: { title: "Account" } },
          ar: { account: { title: "الحساب" } },
        },
      },
      [sibling]: {
        sourceFiles: ["/app/src/web/catalog/locales.json"],
        translationsByLocale: {
          en: { catalog: { title: "Catalog" } },
          ar: { catalog: { title: "الكتالوج" } },
        },
      },
    },
  };
}

describe("createRouteTranslationsResolver", () => {
  it("returns undefined for legacy applications without route locale JSON", () => {
    expect(createRouteTranslationsResolver(undefined)).toBeUndefined();
  });

  it("selects only the requested source and locale", () => {
    const resolve = createRouteTranslationsResolver(manifest())!;

    expect(resolve(source, "en")).toMatchObject({
      locale: "en",
      keywords: { account: { title: "Account" } },
    });
    expect(resolve(sibling, "ar")).toMatchObject({
      locale: "ar",
      keywords: { catalog: { title: "الكتالوج" } },
    });
  });

  it("caches a stable, deeply immutable snapshot without freezing the manifest", () => {
    const input = manifest();
    const resolve = createRouteTranslationsResolver(input)!;
    const first = resolve(source, "en");
    const second = resolve(source, "en");

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.keywords)).toBe(true);
    expect(Object.isFrozen(first.keywords.account)).toBe(true);
    expect(() => {
      (first.keywords.account as { title: string }).title = "Changed";
    }).toThrow();
    expect(input.pages[source]!.translationsByLocale.en).toEqual({ account: { title: "Account" } });
    expect(Object.isFrozen(input.pages[source]!.translationsByLocale.en)).toBe(false);
  });

  it("refuses an unknown source identity or locale instead of falling back", () => {
    const resolve = createRouteTranslationsResolver(manifest())!;

    expect(() => resolve("/unknown.page.tsx", "en")).toThrow(/no manifest entry.*unknown\.page/u);
    expect(() => resolve(source, "fr")).toThrow(/no locale.*fr/u);
  });

  it("changes the cache revision when an edit or deletion changes selected copy", () => {
    const before = manifest();
    const edited = manifest();
    edited.pages[source]!.translationsByLocale.en = { account: { title: "Updated" } };
    const deleted = manifest();
    deleted.pages[source]!.translationsByLocale.en = {};
    const original = createRouteTranslationsResolver(before)!(source, "en").revision;
    expect(createRouteTranslationsResolver(edited)!(source, "en").revision).not.toBe(original);
    expect(createRouteTranslationsResolver(deleted)!(source, "en").revision).not.toBe(original);
    expect(createRouteTranslationsResolver(manifest())!(source, "en").revision).toBe(original);
  });
});
