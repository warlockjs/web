/**
 * Builds a {@link SitemapPageSource} from a production `PageManifest` —
 * every module is already imported by the generated barrel, so this reads
 * route identity off already-loaded module namespaces and never touches the
 * filesystem or `import()`.
 *
 * Route identity is NOT re-derived here: this calls the exact same shared
 * primitives `../server/install-page-routes-from-manifest.ts` composes
 * (`../routing/route-identity.ts`'s `resolvePageRouteIdentity`,
 * `../routing/layout-level.ts`'s `resolveLayoutLevel`,
 * `../routing/compose-route-path.ts`, `../routing/filesystem-route.ts`'s
 * `deriveFilesystemRoutePath`, `../server/layout-prefixes.ts`), in the same
 * order, so a page's sitemap URL and its registered route can never drift.
 */
import { composeRoutePath } from "../routing/compose-route-path";
import { deriveFilesystemRoutePath } from "../routing/filesystem-route";
import { resolveLayoutLevel } from "../routing/layout-level";
import { resolvePageRouteIdentity } from "../routing/route-identity";
import { layoutPrefixesByDirectory } from "../server/layout-prefixes";
import { isNotFoundPageFile } from "../server/not-found-page";
import type { PageManifest, PageManifestPageEntry } from "../server/page-manifest";
import type { LayoutModuleShape, PageModuleShape } from "../server/page-module-shapes";
import type { SitemapPageSource, SitemapPageSourceEntry } from "./sitemap-page-source";

/** `sourceFile`'s path relative to the web root — same derivation as `install-page-routes-from-manifest.ts`'s own `webRelativeSourceFile`. */
function webRelativeSourceFile(sourceFile: string): string {
  return sourceFile.split("/").slice(2).join("/");
}

function layoutPrefixesOf(page: PageManifestPageEntry): Record<string, string> {
  return layoutPrefixesByDirectory(
    page.layouts.map((layout) => {
      const relative = webRelativeSourceFile(layout.sourceFile);
      const slashIndex = relative.lastIndexOf("/");
      const directory = slashIndex === -1 ? "" : relative.slice(0, slashIndex);

      return { directory, prefix: (layout.module as LayoutModuleShape).prefix };
    }),
  );
}

function layoutPrefixOf(page: PageManifestPageEntry): string {
  return resolveLayoutLevel(
    page.sourceFile,
    page.layouts.map((layout) => ({
      id: layout.sourceFile,
      renders: typeof (layout.module as LayoutModuleShape).default !== "undefined",
      prefix: (layout.module as LayoutModuleShape).prefix,
    })),
  ).prefix;
}

/** The page's `{ path, name }` — the same effective route `installPageRoutesFromManifest` registers it on. */
function routeOf(page: PageManifestPageEntry): { path: string; name: string } {
  const routeExport = (page.module as PageModuleShape).route;
  const pageFile = webRelativeSourceFile(page.sourceFile);
  const identity = resolvePageRouteIdentity(routeExport, pageFile, page.sourceFile);

  if (routeExport === undefined) {
    return {
      name: identity.name,
      path: deriveFilesystemRoutePath({ pageFile, layoutPrefixes: layoutPrefixesOf(page) }),
    };
  }

  return { name: identity.name, path: composeRoutePath(layoutPrefixOf(page), identity.path) };
}

/** Every routable page in `manifest.pages`, excluding the not-found page — same exclusion `listRoutablePages` applies for dev. */
export function createManifestSitemapPageSource(manifest: PageManifest): SitemapPageSource {
  return () =>
    manifest.pages
      .filter((page) => !isNotFoundPageFile(page.sourceFile))
      .map((page): SitemapPageSourceEntry => {
        const { path, name } = routeOf(page);
        const pageModule = page.module as {
          metadata?: SitemapPageSourceEntry["metadata"];
          sitemap?: unknown;
        };

        return {
          routeName: name,
          routePath: path,
          metadata: pageModule.metadata,
          sitemap: pageModule.sitemap,
        };
      });
}
