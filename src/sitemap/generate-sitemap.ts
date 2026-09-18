/**
 * `generateSitemap()` — the adapter's one entry point (contract Part 4, Part 6).
 * Discovers pages, expands locales, picks `Sitemap` or `SitemapIndex`
 * automatically, and writes the result via the package's own atomic
 * `saveTo`. Never called from an HTTP request (Part 6 rule 1/5) — the
 * application calls it on an event, a schedule, or a TTL; Part B wires the
 * routes that only ever serve what this last wrote.
 */
import path from "node:path";
import { rootPath } from "@warlock.js/core";
import {
  Sitemap,
  SitemapIndex,
  type RouteSummary,
  type SitemapSetResult,
} from "@warlock.js/sitemap";
import { collectSitemapEntries } from "./collect-sitemap-entries";
import type { CollectedEntry } from "./expand-locale-entries";
import { requireSitemapOrigin, resolveSitemapConfig } from "./resolve-sitemap-config";
import type { SitemapResult } from "./sitemap-result-types";

/** The sitemaps.org ceiling `@warlock.js/sitemap` enforces; mirrored here only to decide WHICH class to build into, never to re-validate it. */
const MAX_URLS_PER_FILE = 50_000;

export type GenerateSitemapOptions = {
  /** Absolute path to the application root. Defaults to `process.cwd()` via `rootPath()`. */
  readonly appRoot?: string;
  readonly srcDir?: string;
};

function mergeDeclaredRoutes(
  routes: readonly RouteSummary[],
  declaredRoutes: ReadonlySet<string>,
): RouteSummary[] {
  const known = new Set(routes.map((route) => route.route));
  const missing = [...declaredRoutes]
    .filter((route) => !known.has(route))
    .map((route) => ({ route, count: 0 }));

  return [...routes, ...missing];
}

export async function generateSitemap(
  options: GenerateSitemapOptions = {},
): Promise<SitemapSetResult | SitemapResult> {
  const config = resolveSitemapConfig();

  if (!config.enabled) {
    return { mode: "disabled", urls: 0, duplicates: [], routes: [] };
  }

  const baseUrl = requireSitemapOrigin(config);
  const appRoot = options.appRoot ?? rootPath();

  const { items, declaredRoutes } = await collectSitemapEntries({
    appRoot,
    srcDir: options.srcDir,
    locales: config.locales,
  });

  const useIndex = items.length > MAX_URLS_PER_FILE || config.locales.splitByLocale;

  if (!useIndex) {
    const sitemap = new Sitemap({ baseUrl, ...config.defaults });

    for (const declared of declaredRoutes) sitemap.declareRoute(declared);
    sitemap.addMany(items.map((item) => item.entry));

    // Published as the whole, owned output directory (the same way the index
    // path publishes), so a site that later needs an index can replace it.
    const outputFile = await sitemap.publishTo(config.outputDir, path.basename(config.path));

    return {
      mode: "single",
      path: outputFile,
      urls: sitemap.size,
      duplicates: sitemap.duplicates(),
      routes: sitemap.routes(),
    };
  }

  const index = new SitemapIndex({ baseUrl, gzip: config.gzip, ...config.defaults });

  if (config.locales.splitByLocale) {
    const byLocale = new Map<string, CollectedEntry[]>();
    const unnamed: CollectedEntry[] = [];

    for (const item of items) {
      if (item.localeCode === undefined) {
        unnamed.push(item);
        continue;
      }

      const group = byLocale.get(item.localeCode) ?? [];
      group.push(item);
      byLocale.set(item.localeCode, group);
    }

    if (unnamed.length > 0) {
      index.addSource(() => unnamed.map((item) => item.entry));
    }

    for (const [locale, group] of byLocale) {
      index.addSource(locale, () => group.map((item) => item.entry));
    }
  } else {
    index.addSource(() => items.map((item) => item.entry));
  }

  const result = await index.saveTo(config.outputDir);

  return { ...result, routes: mergeDeclaredRoutes(result.routes, declaredRoutes) };
}
