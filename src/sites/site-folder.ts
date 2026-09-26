/**
 * The folder below `src/web` that owns a site's root and pages.
 */
export function siteFolder(key: string): string {
  return `$sites/${key}`;
}
