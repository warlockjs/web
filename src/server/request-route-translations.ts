import { transFrom, transFromKeywords } from "@mongez/localization";
import type { Request } from "@warlock.js/core";
import type { RouteTranslations, RouteTranslationsResolver } from "./route-translations";

function hasKeyword(keywords: Record<string, unknown>, keyword: string): boolean {
  let value: unknown = keywords;

  for (const segment of keyword.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return false;
    value = (value as Record<string, unknown>)[segment];
  }

  return true;
}

export function bindRequestRouteTranslations(
  request: Request,
  resolver: RouteTranslationsResolver | undefined,
  sourceFile: string,
): RouteTranslations | undefined {
  if (!resolver) return undefined;
  const translate = (locale: string, keyword: any, placeholders?: any) => {
    const keywords = resolver(sourceFile, locale).keywords;
    return typeof keyword !== "string" || hasKeyword(keywords, keyword)
      ? transFromKeywords(locale, keywords, keyword, placeholders)
      : transFrom(locale, keyword, placeholders);
  };
  request.trans = request.t = (keyword: string, placeholders?: any) =>
    translate(request.locale, keyword, placeholders);
  request.transFrom = translate;
  return resolver(sourceFile, request.locale);
}
