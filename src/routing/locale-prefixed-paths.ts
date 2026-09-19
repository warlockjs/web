/**
 * The literal prefixed registrations a page needs BEYOND its base path, under
 * an active `web.localeRouting.strategy` — design note §A.1: "each page is
 * registered once per prefixed code as a literal static path... a static
 * segment beats a sibling `:slug` in find-my-way, so there's no ambiguity."
 *
 * Pure and synchronous: both installers (`../server/install-page-routes.ts`,
 * `../server/install-page-routes-from-manifest.ts`) call this with the same
 * {@link LocaleRouting} value, so the set of extra routes a page gets can
 * never drift between dev and production.
 */
import { type LocaleRouting, isPrefixedLocale } from "./locale-routing";

export type LocalePrefixedPath = {
  /** The literal registered path, e.g. `/ar/posts` or `/ar` for the root. */
  path: string;
  /** The locale code this registration pins `request.locale` to. */
  locale: string;
};

/**
 * Joins a locale prefix onto `path`, collapsing the root case: `/` + `ar` is
 * `/ar`, never `/ar/` — the design note's own example (§A.1).
 */
export function withLocalePrefix(path: string, code: string): string {
  return path === "/" ? `/${code}` : `/${code}${path}`;
}

/**
 * The prefixed registrations `path` needs, one per code the strategy prefixes
 * (`isPrefixedLocale`), in `routing.codes` order. Returns `[]` under `"none"`
 * and for a code that is not prefixed (the default under
 * `"prefix-except-default"`, which stays on the base registration instead).
 */
export function localePrefixedPaths(path: string, routing: LocaleRouting): LocalePrefixedPath[] {
  if (routing.strategy === "none") return [];

  return routing.codes
    .filter((code) => isPrefixedLocale(routing, code))
    .map((code) => ({ path: withLocalePrefix(path, code), locale: code }));
}
