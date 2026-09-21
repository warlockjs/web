import { describe, expect, it } from "vitest";
import { bindRequestRouteTranslations } from "./request-route-translations";
import type { RouteTranslationsResolver } from "./route-translations";

type RequestLike = { locale: string; t?: any; trans?: any; transFrom?: any };
const resolver: RouteTranslationsResolver = (source, locale) => {
  const values: Record<string, Record<string, Record<string, string>>> = {
    page: { en: { title: "Page" }, ar: { title: "Page AR" } },
    error: { en: { title: "Error" }, ar: { title: "Error AR" } },
    root: { en: { title: "Root" }, ar: { title: "Root AR" } },
  };
  const keywords = values[source]?.[locale];
  if (!keywords) throw new Error(`missing ${source}/${locale}`);
  return { locale, keywords, revision: `${source}-${locale}` };
};

describe("bindRequestRouteTranslations", () => {
  it("isolates concurrent bags and reads request.locale when t/trans run", () => {
    const first: RequestLike = { locale: "en" };
    const second: RequestLike = { locale: "ar" };
    bindRequestRouteTranslations(first as any, resolver, "page");
    bindRequestRouteTranslations(second as any, resolver, "error");
    expect(first.t("title")).toBe("Page");
    expect(second.trans("title")).toBe("Error AR");
    first.locale = "ar";
    expect(first.trans("title")).toBe("Page AR");
    expect(second.t("title")).toBe("Error AR");
  });

  it("allows configured explicit locales, throws unknown, and rebinds only its request", () => {
    const first: RequestLike = { locale: "en" };
    const second: RequestLike = { locale: "en" };
    bindRequestRouteTranslations(first as any, resolver, "page");
    bindRequestRouteTranslations(second as any, resolver, "page");
    expect(first.transFrom("ar", "title")).toBe("Page AR");
    expect(() => first.transFrom("fr", "title")).toThrow("missing page/fr");
    bindRequestRouteTranslations(first as any, resolver, "error");
    expect(first.t("title")).toBe("Error");
    bindRequestRouteTranslations(first as any, resolver, "root");
    expect(first.trans("title")).toBe("Root");
    expect(second.t("title")).toBe("Page");
  });
});
