import { transFromKeywords } from "@mongez/localization";
import type { Request } from "@warlock.js/core";
import type { RouteTranslations, RouteTranslationsResolver } from "./route-translations";

export function bindRequestRouteTranslations(
  request: Request,
  resolver: RouteTranslationsResolver | undefined,
  sourceFile: string,
): RouteTranslations | undefined {
  if (!resolver) return undefined;
  const translate = (locale: string, keyword: any, placeholders?: any) =>
    transFromKeywords(locale, resolver(sourceFile, locale).keywords, keyword, placeholders);
  request.trans = request.t = (keyword: string, placeholders?: any) =>
    translate(request.locale, keyword, placeholders);
  request.transFrom = translate;
  return resolver(sourceFile, request.locale);
}
