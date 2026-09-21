/**
 * The one public surface {@link listRoutablePages} exposes for a consumer
 * that needs the application's routable pages AT RUNTIME, with each page's
 * `metadata` and `sitemap` exports — a static walk
 * ({@link "./discover-pages.ts"}'s `discoverPages`) can read neither, because
 * they are application code, not filesystem shape.
 *
 * `@warlock.js/sitemap` is the first consumer, but this is not sitemap-shaped:
 * it names no sitemap concept, so canonical links, OG tags or anything else
 * that needs a page's declared exports can use it too.
 */
import { pathToFileURL } from "node:url";
import type { PageMetadata } from "../metadata";
import { normalizePageModule } from "../server/normalize-page-module";
import { NOT_FOUND_ROUTE_NAME, NOT_FOUND_ROUTE_PATH } from "../server/not-found-page";
import {
  discoverPages,
  isDiscoveredRoutablePage,
  type DiscoverPagesOptions,
} from "./discover-pages";

/** One routable page, with its module's `metadata`/`sitemap` exports resolved. */
export type ListedRoutablePage = {
  routeName: string;
  routePath: string;
  /** The page module's `metadata` export, exactly as it declared it — static object or function form. */
  metadata?: PageMetadata;
  /** The page module's `sitemap` export, exactly as it declared it — a caller that cares about its shape (e.g. `@warlock.js/sitemap`) narrows it itself. */
  sitemap?: unknown;
  /**
   * What each layout on this page's path declared, OUTERMOST FIRST — raw, and
   * deliberately unresolved here.
   *
   * The precedence rule between these and the page's own `sitemap` lives in
   * ONE place (`../sitemap/resolve-layout-sitemap.ts`), called from ONE place
   * (`collectSitemapEntries`). If each page SOURCE resolved it instead, dev
   * and production would each hold a copy of the rule, and two copies of a
   * rule are what canon `b8e6ede3` is about.
   */
  layoutSitemaps?: readonly { sourceFile: string; declared: unknown }[];
};

/**
 * Every routable page in the application, EXCLUDING the not-found route and
 * error pages (the latter are not a routable page at all —
 * {@link isDiscoveredRoutablePage} already excludes them).
 *
 * Imports each page module directly (`import()`, not `vite.ssrLoadModule`):
 * unlike the dev route installer, this reads only a module's own exports, not
 * its rendered output, so it needs no Vite instance. Dev-only in practice —
 * production reads the built page manifest instead (see
 * `../sitemap/collect-sitemap-entries.ts`), since a production build carries
 * no page source files to `import()`.
 */
export async function listRoutablePages(
  options: DiscoverPagesOptions,
): Promise<ListedRoutablePage[]> {
  const pages = discoverPages(options)
    .filter(isDiscoveredRoutablePage)
    .filter(
      (page) => page.routeName !== NOT_FOUND_ROUTE_NAME && page.routePath !== NOT_FOUND_ROUTE_PATH,
    );

  return Promise.all(
    pages.map(async (page) => {
      const pageModule = normalizePageModule(
        await import(pathToFileURL(page.pageFile).href),
        "page",
        page.pageFile,
      );

      // `page.layouts` is already outermost-first, which is the order the
      // precedence rule expects — the nearest ancestor is the last one that
      // declared. Read the same way production does, off the module, so both
      // pipelines learn a layout's policy by the same mechanism.
      const layoutSitemaps = await Promise.all(
        page.layouts.map(async (layoutFile) => ({
          sourceFile: layoutFile,
          declared: normalizePageModule(
            await import(pathToFileURL(layoutFile).href),
            "layout",
            layoutFile,
          ).sitemap,
        })),
      );

      return {
        routeName: page.routeName,
        routePath: page.routePath,
        metadata: pageModule.metadata,
        sitemap: pageModule.sitemap,
        layoutSitemaps,
      };
    }),
  );
}
