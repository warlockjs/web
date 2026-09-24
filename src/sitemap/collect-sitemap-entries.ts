/**
 * Discovery + exclusion + dynamic suppliers (contract Part 4, "What the
 * adapter owns" 1–3) — the one place that turns the application's page
 * graph into plain `@warlock.js/sitemap` entries. Reads pages through an
 * injected {@link SitemapPageSource}: an explicit `options.pageSource` wins,
 * otherwise the production source registered by `WebConnector.boot()`
 * (`./production-sitemap-page-source.ts`) is used when present, and dev
 * falls back to `listRoutablePages` (`../build/list-routable-pages`), which
 * `import()`s each page's SOURCE file — never reachable in a production
 * build, which is why production always registers its own source first.
 */
import type { DiscoverPagesOptions } from "../build/discover-pages";
import { listRoutablePages } from "../build/list-routable-pages";
import {
  expandLocaleEntries,
  localeInvariantEntry,
  type CollectedEntry,
  type LocaleMatrix,
} from "./expand-locale-entries";
import { getProductionSitemapPageSource } from "./production-sitemap-page-source";
import { resolveSitemapDeclaration } from "./resolve-layout-sitemap";
import {
  isSitemapPageEntriesDeclaration,
  type SitemapModelLike,
  type SitemapPageOptions,
  type SitemapPageSupplier,
  type SitemapPageUrl,
} from "./sitemap-page-export";
import type { SitemapPageSource } from "./sitemap-page-source";

export type CollectSitemapEntriesOptions = DiscoverPagesOptions & {
  readonly locales: LocaleMatrix;
  /** Injected page source — bypasses both the production registry and `listRoutablePages`. Primarily for tests. */
  readonly pageSource?: SitemapPageSource;
};

export type CollectedSitemapEntries = {
  readonly items: readonly CollectedEntry[];
  /** Model dependencies declared by page-owned entries suppliers, deduplicated by identity. */
  readonly models?: readonly SitemapModelLike[];
  /**
   * Every dynamic route pattern found with no supplier, plus every route a
   * supplier declared (contract: "a dynamic route without a supplier is
   * reported by name in the diagnostic ... never silently dropped").
   */
  readonly declaredRoutes: ReadonlySet<string>;
};

// A `[locale]` folder yields a literal `:locale` param that `expandLocaleEntries`
// substitutes per locale, so it alone does not make a page dynamic.
const isDynamicRoute = (routePath: string): boolean =>
  routePath.replace(/(^|\/):locale(?=\/|$)/g, "$1").includes(":");

async function resolveSupplier(supplier: SitemapPageSupplier): Promise<SitemapPageUrl[]> {
  return [...(await supplier())];
}

function collectSupplierUrls(
  items: CollectedEntry[],
  urls: readonly SitemapPageUrl[],
  routePath: string | undefined,
  pageOptions: SitemapPageOptions | undefined,
  locales: LocaleMatrix,
): void {
  for (const url of urls) {
    if (pageOptions?.locales === false) items.push(localeInvariantEntry(url, routePath));
    else items.push(...expandLocaleEntries(url, routePath, locales));
  }
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

async function readSitemapPages(
  options: CollectSitemapEntriesOptions,
): Promise<Awaited<ReturnType<SitemapPageSource>>> {
  const pageSource =
    options.pageSource ?? getProductionSitemapPageSource() ?? (() => listRoutablePages(options));

  return pageSource();
}

/**
 * Finds model dependencies without invoking page-owned entry suppliers. This
 * lets lifecycle wiring observe `invalidateOn` even when boot generation is
 * disabled or deferred.
 */
export async function collectSitemapModelDependencies(
  options: CollectSitemapEntriesOptions,
): Promise<readonly SitemapModelLike[]> {
  const models = new Set<SitemapModelLike>();

  for (const page of await readSitemapPages(options)) {
    const sitemapExport = resolveSitemapDeclaration(page.sitemap, page.layoutSitemaps ?? []);
    if (!isSitemapPageEntriesDeclaration(sitemapExport)) continue;

    for (const model of sitemapExport.invalidateOn ?? []) models.add(model);
  }

  return [...models];
}

export async function collectSitemapEntries(
  options: CollectSitemapEntriesOptions,
): Promise<CollectedSitemapEntries> {
  const pages = await readSitemapPages(options);
  const items: CollectedEntry[] = [];
  const declaredRoutes = new Set<string>();
  const models = new Set<SitemapModelLike>();

  for (const page of pages) {
    // THE one call site for the layout/page precedence rule. Both page sources
    // hand over raw declarations — the page's own and each layout's on its
    // path — and the rule is applied here, once, so dev and production cannot
    // disagree about a sitemap without the disagreement being this line
    // (canon `b8e6ede3`). See `contracts/layout-sitemap-and-robots-5.17.md`.
    const sitemapExport = resolveSitemapDeclaration(page.sitemap, page.layoutSitemaps ?? []);

    // Opt-out — never emitted, and never declared, either: an author who
    // wrote `false` asked for silence, not a zero-count row.
    if (sitemapExport === false) continue;

    if (isDynamicRoute(page.routePath)) {
      declaredRoutes.add(page.routePath);

      // A dynamic pattern is not a URL. Only a supplier FUNCTION can name the
      // concrete paths behind it; anything else (no export, or a static
      // options object, which has no path to apply to) contributes nothing
      // and is reported via `declaredRoutes` instead of silently dropped.
      const supplier =
        typeof sitemapExport === "function"
          ? sitemapExport
          : isSitemapPageEntriesDeclaration(sitemapExport)
            ? sitemapExport.entries
            : undefined;
      if (!supplier) continue;

      if (isSitemapPageEntriesDeclaration(sitemapExport)) {
        for (const model of sitemapExport.invalidateOn ?? []) models.add(model);
      }

      const urls = await resolveSupplier(supplier);
      collectSupplierUrls(
        items,
        urls,
        page.routePath,
        isSitemapPageEntriesDeclaration(sitemapExport) ? sitemapExport : undefined,
        options.locales,
      );

      continue;
    }

    // Static page.
    const supplier =
      typeof sitemapExport === "function"
        ? sitemapExport
        : isSitemapPageEntriesDeclaration(sitemapExport)
          ? sitemapExport.entries
          : undefined;
    if (supplier) {
      if (isSitemapPageEntriesDeclaration(sitemapExport)) {
        for (const model of sitemapExport.invalidateOn ?? []) models.add(model);
      }

      const urls = await resolveSupplier(supplier);
      collectSupplierUrls(
        items,
        urls,
        undefined,
        isSitemapPageEntriesDeclaration(sitemapExport) ? sitemapExport : undefined,
        options.locales,
      );

      continue;
    }

    const pageOptions: SitemapPageOptions =
      typeof sitemapExport === "object" && sitemapExport !== null ? sitemapExport : {};
    const url = toPageUrl(page.routePath, pageOptions);

    if (pageOptions.locales === false) {
      items.push(localeInvariantEntry(url, undefined));
      continue;
    }

    items.push(...expandLocaleEntries(url, undefined, options.locales));
  }

  return models.size === 0
    ? { items, declaredRoutes }
    : { items, models: [...models], declaredRoutes };
}
