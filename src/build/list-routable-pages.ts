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
import { NOT_FOUND_ROUTE_NAME, NOT_FOUND_ROUTE_PATH } from "../server/not-found-page";
import {
  discoverPages,
  isDiscoveredRoutablePage,
  type DiscoverPagesOptions,
} from "./discover-pages";

/** The subset of a page module's exports {@link listRoutablePages} reads. */
type ListedPageModule = {
  metadata?: PageMetadata;
  sitemap?: unknown;
};

/** One routable page, with its module's `metadata`/`sitemap` exports resolved. */
export type ListedRoutablePage = {
  routeName: string;
  routePath: string;
  /** The page module's `metadata` export, exactly as it declared it — static object or function form. */
  metadata?: PageMetadata;
  /** The page module's `sitemap` export, exactly as it declared it — a caller that cares about its shape (e.g. `@warlock.js/sitemap`) narrows it itself. */
  sitemap?: unknown;
};

/**
 * Every routable page in the application, EXCLUDING the not-found route and
 * error pages (the latter are not a routable page at all —
 * {@link isDiscoveredRoutablePage} already excludes them).
 *
 * Imports each page module directly (`import()`, not `vite.ssrLoadModule`):
 * unlike the dev route installer, this reads only a module's own exports, not
 * its rendered output, so it needs no Vite instance and works the same way in
 * dev and production.
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
      const pageModule = (await import(pathToFileURL(page.pageFile).href)) as ListedPageModule;

      return {
        routeName: page.routeName,
        routePath: page.routePath,
        metadata: pageModule.metadata,
        sitemap: pageModule.sitemap,
      };
    }),
  );
}
