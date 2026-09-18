/**
 * Discovery + exclusion + dynamic suppliers (contract Part 4, "What the
 * adapter owns" 1–3) — the one place that turns the application's page
 * graph into plain `@warlock.js/sitemap` entries. Reads
 * `listRoutablePages` from `../build/list-routable-pages` directly (a
 * relative import within this package; `@warlock.js/web/build` is the
 * published subpath the same module resolves through from outside).
 */
import type { DiscoverPagesOptions } from "../build/discover-pages";
import { listRoutablePages } from "../build/list-routable-pages";
import {
  expandLocaleEntries,
  localeInvariantEntry,
  type CollectedEntry,
  type LocaleMatrix,
} from "./expand-locale-entries";
import type { SitemapPageExport, SitemapPageOptions, SitemapPageUrl } from "./sitemap-page-export";

export type CollectSitemapEntriesOptions = DiscoverPagesOptions & {
  readonly locales: LocaleMatrix;
};

export type CollectedSitemapEntries = {
  readonly items: readonly CollectedEntry[];
  /**
   * Every dynamic route pattern found with no supplier, plus every route a
   * supplier declared (contract: "a dynamic route without a supplier is
   * reported by name in the diagnostic ... never silently dropped").
   */
  readonly declaredRoutes: ReadonlySet<string>;
};

const isDynamicRoute = (routePath: string): boolean => routePath.includes(":");

async function resolveSupplier(
  supplier: () => Promise<Iterable<SitemapPageUrl>> | Iterable<SitemapPageUrl>,
): Promise<SitemapPageUrl[]> {
  return [...(await supplier())];
}

function toPageUrl(routePath: string, options: SitemapPageOptions): SitemapPageUrl {
  return {
    path: routePath,
    lastmod: options.lastmod,
    changefreq: options.changefreq,
    priority: options.priority,
    localePaths: options.localePaths,
  };
}

export async function collectSitemapEntries(
  options: CollectSitemapEntriesOptions,
): Promise<CollectedSitemapEntries> {
  const pages = await listRoutablePages(options);
  const items: CollectedEntry[] = [];
  const declaredRoutes = new Set<string>();

  for (const page of pages) {
    const sitemapExport = page.sitemap as SitemapPageExport | undefined;

    // Opt-out — never emitted, and never declared, either: an author who
    // wrote `false` asked for silence, not a zero-count row.
    if (sitemapExport === false) continue;

    if (isDynamicRoute(page.routePath)) {
      declaredRoutes.add(page.routePath);

      // A dynamic pattern is not a URL. Only a supplier FUNCTION can name the
      // concrete paths behind it; anything else (no export, or a static
      // options object, which has no path to apply to) contributes nothing
      // and is reported via `declaredRoutes` instead of silently dropped.
      if (typeof sitemapExport !== "function") continue;

      const urls = await resolveSupplier(sitemapExport);

      for (const url of urls) {
        items.push(...expandLocaleEntries(url, page.routePath, options.locales));
      }

      continue;
    }

    // Static page.
    if (typeof sitemapExport === "function") {
      const urls = await resolveSupplier(sitemapExport);

      for (const url of urls) {
        items.push(...expandLocaleEntries(url, undefined, options.locales));
      }

      continue;
    }

    const pageOptions = sitemapExport ?? {};
    const url = toPageUrl(page.routePath, pageOptions);

    if (pageOptions.locales === false) {
      items.push(localeInvariantEntry(url, undefined));
      continue;
    }

    items.push(...expandLocaleEntries(url, undefined, options.locales));
  }

  return { items, declaredRoutes };
}
