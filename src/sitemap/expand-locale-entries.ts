/**
 * Locale expansion — contract Part 5. The package understands `hreflang`
 * because that is protocol; it never derives a locale path itself, so every
 * path below is built here, once, and handed to `@warlock.js/sitemap` as a
 * plain concrete path.
 *
 * Warlock has no URL-prefix locale routing: a request's locale resolves from
 * `?locale=` query, then cookie, then header (`core/src/http/request.ts`).
 * A `/en/about` URL would not route anywhere. The adapter's default
 * convention is therefore the page's own `path` with `?locale=<code>`
 * appended (`&locale=<code>` when `path` already carries a query string),
 * unless the page's own `localePaths` names a divergent slug for that locale
 * (contract 5(b), which always wins), or the app supplies its own
 * `web.sitemap.localeUrl` hook for apps that implement prefix routing
 * themselves. A page's own bare path is used as-is only when it opts out of
 * expansion entirely (`locales: false`, contract 5(a)).
 */
import type { ChangeFreq, SitemapAlternate, SitemapEntry, SitemapImage } from "@warlock.js/sitemap";

export type SitemapPageUrl = {
  readonly path: string;
  readonly lastmod?: string | Date;
  readonly changefreq?: ChangeFreq;
  readonly priority?: number;
  /** Per-locale paths for THIS url, when slugs diverge. */
  readonly localePaths?: Readonly<Record<string, string>>;
  readonly images?: readonly SitemapImage[];
};

export type LocaleMatrix = {
  readonly codes: readonly string[];
  readonly defaultLocale?: string;
  /** App override for the default `?locale=<code>` URL convention — `web.sitemap.localeUrl`. */
  readonly localeUrl?: (path: string, localeCode: string) => string;
  /**
   * True when `web.localeRouting.strategy` is active — design note §D.1.
   * `resolveSitemapConfig()` is the one place this is decided (it also folds
   * a strategy-aware default into {@link localeUrl} when the app did not set
   * its own), so `x-default` here can point at the DEFAULT LOCALE'S OWN URL
   * (prefixed or bare, whichever the strategy gives it) instead of always
   * the bare `path` — bare would be wrong under `"prefix"`, where the
   * default locale is prefixed too. `undefined`/`false` keeps today's
   * behaviour: `x-default` always the bare path.
   */
  readonly localeRoutingActive?: boolean;
};

/** One collected URL, tagged with the locale it primarily belongs to — `undefined` when locale-invariant or the app has no configured locales. */
export type CollectedEntry = {
  readonly localeCode?: string;
  readonly entry: SitemapEntry;
};

/** The package default: `path` with `?locale=<code>` appended, or `&locale=<code>` when `path` already has a query string. */
function defaultLocaleUrl(path: string, code: string): string {
  const separator = path.includes("?") ? "&" : "?";

  return `${path}${separator}locale=${encodeURIComponent(code)}`;
}

/**
 * True for a page whose path carries the literal `:locale` route param — a
 * `[locale]`-folder page (design note §C, §D.1's last bullet). Such a page
 * has no bare form at all: EVERY locale, including the default, substitutes
 * into the same segment.
 */
function hasLocaleParam(path: string): boolean {
  return /(^|\/):locale(\/|$)/.test(path);
}

/** Substitutes `code` into a `[locale]`-folder page's literal `:locale` segment. */
function substituteLocaleParam(path: string, code: string): string {
  return path.replace(
    /(^|\/):locale(\/|$)/,
    (_match, before: string, after: string) => `${before}${code}${after}`,
  );
}

function pathForLocale(url: SitemapPageUrl, code: string, matrix: LocaleMatrix): string {
  if (url.localePaths?.[code] !== undefined) return url.localePaths[code];
  if (hasLocaleParam(url.path)) return substituteLocaleParam(url.path, code);

  return (matrix.localeUrl ?? defaultLocaleUrl)(url.path, code);
}

function toEntry(
  path: string,
  url: SitemapPageUrl,
  route: string | undefined,
  alternates?: readonly SitemapAlternate[],
): SitemapEntry {
  return {
    path,
    ...(route !== undefined ? { route } : {}),
    ...(url.lastmod !== undefined ? { lastmod: url.lastmod } : {}),
    ...(url.changefreq !== undefined ? { changefreq: url.changefreq } : {}),
    ...(url.priority !== undefined ? { priority: url.priority } : {}),
    ...(url.images !== undefined ? { images: url.images } : {}),
    ...(alternates !== undefined ? { alternates } : {}),
  };
}

/**
 * Expands one page-supplied URL into one `CollectedEntry` per configured
 * locale — contract 5(d): N locales produce N primary `<url>` entries, each
 * carrying the COMPLETE reciprocal alternate set including itself, plus
 * `x-default` when `defaultLocale` is configured (5(c)). `x-default` always
 * points at the page's bare `path` — it names the language-neutral fallback,
 * not any one locale's query-tagged URL.
 *
 * With no locales configured (`matrix.codes` empty) this degrades to a
 * single, alternate-free entry at the page's own path — the single-locale
 * app that never opted into locale expansion at all.
 */
export function expandLocaleEntries(
  url: SitemapPageUrl,
  route: string | undefined,
  matrix: LocaleMatrix,
): CollectedEntry[] {
  if (matrix.codes.length === 0) {
    return [{ entry: toEntry(url.path, url, route) }];
  }

  const alternates: SitemapAlternate[] = matrix.codes.map((code) => ({
    hreflang: code,
    path: pathForLocale(url, code, matrix),
  }));

  if (matrix.defaultLocale) {
    // Design note §D.1: under an active strategy (or a `:locale`-folder
    // page), `x-default` points at the DEFAULT locale's own resolved URL —
    // bare under `"prefix-except-default"`, but PREFIXED under `"prefix"`
    // or a `:locale` page, where the bare `path` either redirects or does
    // not resolve at all. Outside that (today's `?locale=` convention, or an
    // app's own unrelated `localeUrl` hook), `x-default` keeps pointing at
    // the page's bare `path` — the language-neutral fallback, unchanged.
    const xDefaultPath =
      matrix.localeRoutingActive || hasLocaleParam(url.path)
        ? pathForLocale(url, matrix.defaultLocale, matrix)
        : url.path;

    alternates.push({ hreflang: "x-default", path: xDefaultPath });
  }

  return matrix.codes.map((code) => ({
    localeCode: code,
    entry: toEntry(pathForLocale(url, code, matrix), url, route, alternates),
  }));
}

/** Contract 5(a): a locale-invariant page is one entry, zero alternates, at its own bare path. */
export function localeInvariantEntry(
  url: SitemapPageUrl,
  route: string | undefined,
): CollectedEntry {
  return { entry: toEntry(url.path, url, route) };
}
