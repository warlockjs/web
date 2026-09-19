/**
 * The PAGE SOURCE contract `collectSitemapEntries` reads pages through
 * (v5.16 production-manifest ruling). Dev's own source is
 * `../build/list-routable-pages.ts`'s `listRoutablePages`, which `import()`s
 * each page's SOURCE file — impossible in a production build, where those
 * files do not exist beside the bundle. A production process instead injects
 * `./manifest-sitemap-page-source.ts`'s source, built from the connector's
 * already-imported `PageManifest`, so no file is ever imported to produce a
 * sitemap.
 */
import type { ListedRoutablePage } from "../build/list-routable-pages";

/** One routable page's identity + declared exports — the shape both sources produce. */
export type SitemapPageSourceEntry = ListedRoutablePage;

/** Every routable page, excluding the not-found/error page. May resolve sync or async. */
export type SitemapPageSource = () =>
  Promise<readonly SitemapPageSourceEntry[]> | readonly SitemapPageSourceEntry[];
