/**
 * The page-level `export const sitemap = ...` contract (Part 4). Read
 * dynamically off `ListedRoutablePage.sitemap` by `collect-sitemap-entries.ts` —
 * `listRoutablePages` types this field as `unknown` deliberately (it names no
 * sitemap concept), so this module is the one place its shape is trusted.
 */
import type { ChangeFreq } from "@warlock.js/sitemap";
import type { SitemapPageUrl } from "./expand-locale-entries";

export type { SitemapPageUrl };

/**
 * Static per-page options. `SitemapPageOptions` is named but not spelled out
 * in the v5.16 contract text — filled in here per the card's description
 * ("static options (priority/changefreq/lastmod), `locales: false` for
 * locale-invariant pages"). `localePaths` covers the same divergent-slug case
 * `SitemapPageUrl.localePaths` does, for a static page that never returns a
 * supplier function.
 */
export type SitemapPageOptions = {
  readonly priority?: number;
  readonly changefreq?: ChangeFreq;
  readonly lastmod?: string | Date;
  /** `false` opts this page out of locale expansion entirely — contract 5(a). */
  readonly locales?: false;
  readonly localePaths?: Readonly<Record<string, string>>;
};

/** A page opts out (`false`), declares static options, or supplies its URLs. */
export type SitemapPageExport =
  false | SitemapPageOptions | (() => Promise<Iterable<SitemapPageUrl>> | Iterable<SitemapPageUrl>);
