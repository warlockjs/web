/**
 * The `<head>` half of design note §D.2: the `<link rel="alternate"
 * hreflang="...">` set for the CURRENT request, on a locale-routed page —
 * either an active `web.localeRouting.strategy` (§A) or a `:locale`-folder
 * route (§C, card C).
 *
 * Deliberately a pure function over an already-resolved {@link LocaleRouting}
 * and origin, not a reader of `readLocaleRouting()`/`getPublicUrl()` itself —
 * the caller (`render-page.ts`) owns reading those, this owns only the
 * arithmetic, so it is trivial to unit test without publishing global state.
 *
 * The absolute-URL join is `@warlock.js/sitemap`'s own `joinOrigin` — the
 * SAME origin-joining rule `resolve-sitemap-config.ts`'s `getPublicUrl()` +
 * `@warlock.js/sitemap`'s `Sitemap`/`SitemapIndex` already use for every
 * `<loc>`/alternate the sitemap emits, reused here rather than duplicated.
 */
import { joinOrigin } from "@warlock.js/sitemap";
import { isPrefixedLocale, type LocaleRouting } from "../routing/locale-routing";
import { withLocalePrefix } from "../routing/locale-prefixed-paths";

export type LocaleAlternate = {
  readonly hreflang: string;
  readonly href: string;
};

/** True for a route pattern whose first segment is the `:locale` param (design note §C.1). */
export function isLocaleFolderRoute(routeEntryPath: string): boolean {
  return routeEntryPath === "/:locale" || routeEntryPath.startsWith("/:locale/");
}

/**
 * The RUNTIME routing table to carry onto `DocumentContextValue.localeRouting`
 * for THIS request — `undefined` under the exact same gate
 * {@link resolveLocaleAlternates} already applies (strategy `"none"` and not a
 * `:locale` route): a page that is not locale-routed at all has nothing for
 * the browser's `<Link>`/`changeLocaleCode` to prefix against, so `<Head/>`
 * emits no `warlock-locale-routing` meta for it either.
 *
 * Unlike {@link resolveLocaleAlternates}, this needs no origin and no
 * configured codes — it is the routing table itself, not a set of absolute
 * URLs built from it — so it is `undefined` only on the strategy/route gate,
 * never on a missing `getPublicUrl()`.
 */
export function resolveDocumentLocaleRouting(
  routeEntryPath: string,
  routing: LocaleRouting,
): LocaleRouting | undefined {
  if (routing.strategy === "none" && !isLocaleFolderRoute(routeEntryPath)) return undefined;

  return routing;
}

/**
 * Strips a leading `/<code>` segment for whichever configured code the
 * current path is prefixed with — the inverse of `withLocalePrefix`. Not
 * gated on `isPrefixedLocale`: under `:locale`, EVERY code appears as a
 * prefix on some request, and under `"prefix"` so does the default, so
 * trying every code is simpler and correct for both.
 */
function stripLocalePrefix(pathname: string, codes: readonly string[]): string {
  for (const code of codes) {
    const prefix = `/${code}`;

    if (pathname === prefix) return "/";
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }

  return pathname;
}

/**
 * The path `code`'s alternate resolves to, BEFORE joining the origin.
 * `:locale` routes have no bare form — every code, including the default,
 * is prefixed (mirrors `"prefix"`, design note §C). Under a config strategy,
 * only the codes `isPrefixedLocale` says are prefixed get one; the rest
 * (the default, under `"prefix-except-default"`) stay bare.
 */
function pathForCode(
  barePath: string,
  code: string,
  routing: LocaleRouting,
  localeFolder: boolean,
): string {
  if (localeFolder) return withLocalePrefix(barePath, code);

  return isPrefixedLocale(routing, code) ? withLocalePrefix(barePath, code) : barePath;
}

/**
 * Builds the full hreflang alternate set for the current request, or
 * `undefined` when the page is not locale-routed at all (strategy `"none"`
 * and not a `:locale` route — design note bullet "Strategy none → today's
 * behaviour unchanged", mirrored here for `<head>`), when there is no
 * configured origin to build an absolute URL from, or when no locale codes
 * are configured.
 */
export function resolveLocaleAlternates(
  requestPath: string,
  routeEntryPath: string,
  routing: LocaleRouting,
  origin: string | undefined,
): LocaleAlternate[] | undefined {
  if (!origin) return undefined;
  if (routing.codes.length === 0) return undefined;

  const localeFolder = isLocaleFolderRoute(routeEntryPath);

  if (routing.strategy === "none" && !localeFolder) return undefined;

  const [pathname = "/"] = (requestPath || "/").split("?");
  const barePath = stripLocalePrefix(pathname, routing.codes);

  const alternates: LocaleAlternate[] = routing.codes.map((code) => ({
    hreflang: code,
    href: joinOrigin(origin, pathForCode(barePath, code, routing, localeFolder)),
  }));

  if (routing.defaultLocale) {
    alternates.push({
      hreflang: "x-default",
      href: joinOrigin(origin, pathForCode(barePath, routing.defaultLocale, routing, localeFolder)),
    });
  }

  return alternates;
}
