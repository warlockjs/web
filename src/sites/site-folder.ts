import type { SiteConfig } from "./site-config.types";

/**
 * The folder below `src/web` that owns a site's root and pages.
 *
 * An explicit route group remains supported for existing apps. Sites without
 * one use the convention folder, whose `$sites` segment is routing-neutral.
 */
export function siteFolder(key: string, site: SiteConfig): string {
  return site.pages ?? `$sites/${key}`;
}
