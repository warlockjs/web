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
import {
  requireSitemapOrigin,
  resolveSitemapConfig,
  type ResolvedSitemapConfig,
} from "./resolve-sitemap-config";
import type { SitemapResult } from "./sitemap-result-types";
import type { SitemapModelLike } from "./sitemap-page-export";
import type { SitemapPageSource } from "./sitemap-page-source";

/** The sitemaps.org ceiling `@warlock.js/sitemap` enforces; mirrored here only to decide WHICH class to build into, never to re-validate it. */
const MAX_URLS_PER_FILE = 50_000;

function reportImageLimit(event: { readonly route?: string; readonly dropped: number }): void {
  const route = event.route ?? "unattributed sitemap entry";
  console.warn(
    `[warlock:web] sitemap ${route} exceeded the 1,000-image limit; dropped ${event.dropped} image(s).`,
  );
}

export type GenerateSitemapOptions = {
  /** Absolute path to the application root. Defaults to `process.cwd()` via `rootPath()`. */
  readonly appRoot?: string;
  readonly srcDir?: string;
  /** Injected page source — forwarded to `collectSitemapEntries`. Primarily for tests; production picks up its own source automatically. */
  readonly pageSource?: SitemapPageSource;
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

export type GeneratedSitemapArtifacts = {
  readonly result: SitemapSetResult | SitemapResult;
  /**
   * Domain models that supplied dynamic entries, when collection exposes them.
   * Discovery grows that metadata independently; keeping this fallback makes
   * the generator usable before the collector and publisher land together.
   */
  readonly models: readonly SitemapModelLike[];
};

/**
 * The reusable generation core. It receives resolved policy so a publisher can
 * direct an otherwise identical run to an owned staging directory.
 *
 * This is intentionally internal: the public one-shot API remains
 * {@link generateSitemap}, which resolves app configuration itself.
 */
export async function generateSitemapArtifacts(
  options: GenerateSitemapOptions,
  resolvedConfig: ResolvedSitemapConfig,
  shardPathPrefix?: string,
): Promise<GeneratedSitemapArtifacts> {
  if (!resolvedConfig.enabled) {
    return {
      result: { mode: "disabled", urls: 0, duplicates: [], routes: [] },
      models: [],
    };
  }

  const baseUrl = requireSitemapOrigin(resolvedConfig);
  const appRoot = options.appRoot ?? rootPath();

  const collected = await collectSitemapEntries({
    appRoot,
    srcDir: options.srcDir,
    locales: resolvedConfig.locales,
    pageSource: options.pageSource,
  });
  const { items, declaredRoutes } = collected;
  const models =
    (collected as typeof collected & { readonly models?: readonly SitemapModelLike[] }).models ??
    [];

  const useIndex = items.length > MAX_URLS_PER_FILE || resolvedConfig.locales.splitByLocale;
  const outputDir = resolvedConfig.outputDir;

  if (!useIndex) {
    const sitemap = new Sitemap({
      baseUrl,
      ...resolvedConfig.defaults,
      onImageLimitExceeded: reportImageLimit,
    });

    for (const declared of declaredRoutes) sitemap.declareRoute(declared);
    sitemap.addMany(items.map((item) => item.entry));

    // Published as the whole, owned output directory (the same way the index
    // path publishes), so a site that later needs an index can replace it.
    const outputFile = await sitemap.publishTo(outputDir, path.basename(resolvedConfig.path));

    return {
      result: {
        mode: "single",
        path: outputFile,
        urls: sitemap.size,
        duplicates: sitemap.duplicates(),
        routes: sitemap.routes(),
      },
      models,
    };
  }

  const index = new SitemapIndex({
    baseUrl,
    gzip: resolvedConfig.gzip,
    shardPathPrefix,
    ...resolvedConfig.defaults,
    onImageLimitExceeded: reportImageLimit,
  });

  if (resolvedConfig.locales.splitByLocale) {
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

  const result = await index.saveTo(outputDir);

  return {
    result: { ...result, routes: mergeDeclaredRoutes(result.routes, declaredRoutes) },
    models,
  };
}

export async function generateSitemap(
  options: GenerateSitemapOptions = {},
): Promise<SitemapSetResult | SitemapResult> {
  const resolvedConfig = resolveSitemapConfig();
  const generated = await generateSitemapArtifacts(options, resolvedConfig);

  return generated.result;
}
