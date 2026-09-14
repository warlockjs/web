/**
 * THE layout-prefix-by-directory table both page installers build for
 * {@link deriveFilesystemRoutePath} (`../routing/filesystem-route.ts`) — the
 * table that lets a directory's own `layout.tsx` rename the URL segment a bare
 * directory name would otherwise contribute, for a page with no explicit
 * `route` export.
 *
 * Dev (`./install-page-routes.ts`'s `resolveLayoutLevel`) and production
 * (`./install-page-routes-from-manifest.ts`'s `layoutPrefixesOf`) read a
 * layout's declared `prefix` off two different representations of "which
 * layout" — a live Vite-loaded module keyed by its filesystem directory in
 * dev, an already-built manifest entry keyed by its `sourceFile` in
 * production — so DERIVING the directory stays each installer's own job. This
 * module starts only once every entry already carries its OWN directory and
 * its OWN `prefix` (or the absence of one): building the `Record<string,
 * string>` from that list is the one rule both installers were applying
 * identically already.
 */

/** One layout's directory (POSIX, relative to the web root; `""` for the root) and its declared `prefix`, if any. */
export type LayoutPrefixEntry = {
  directory: string;
  prefix: string | undefined;
};

/**
 * Folds layout directory/prefix readings into the table
 * {@link deriveFilesystemRoutePath} consults, keyed by directory. A layout
 * that declares no `prefix` contributes no entry — the caller's directory
 * name is used as-is for that segment — rather than an entry mapping to
 * `undefined`, which would have to be filtered again downstream.
 *
 * Later entries win on a directory collision, matching `Object.fromEntries`'s
 * own last-write-wins behaviour; a page's layout chain never repeats a
 * directory, so this only matters if a caller hands in a malformed chain.
 */
export function layoutPrefixesByDirectory(
  entries: readonly LayoutPrefixEntry[],
): Record<string, string> {
  return Object.fromEntries(
    entries.flatMap((entry) =>
      entry.prefix === undefined ? [] : [[entry.directory, entry.prefix]],
    ),
  );
}
