/**
 * Route-path composition — the single, pure rule for turning a layout's
 * declared `prefix` and a page's declared `route.path` into the page's
 * effective, registered path. Previously three hand-written copies: the dev
 * installer (`web/src/server/install-page-routes.ts`), the production
 * manifest installer (`web/src/server/install-page-routes-from-manifest.ts`)
 * and build discovery (`web/src/build/discover-pages.ts`) each carried this
 * exact rule so build and boot could not quietly disagree about it; all
 * three now delegate here instead.
 *
 * DIRECTORY CONTRACT — applies to everything in `web/src/routing/`: nothing
 * here may import `node:fs`, `node:path`, `vite`, or `fastify`. This module
 * receives canonical values and trusts nothing about them beyond the input
 * contract asserted below — it asserts rather than trusts, but it never
 * repairs.
 */

/**
 * A page's effective path: its nearest layout's `prefix` followed by its own
 * declared `route.path`. A root prefix ("/") and a root path ("/") each
 * contribute nothing, so neither adds a slash of its own; every other case
 * joins on the slash `routePath` already starts with, which is what keeps a
 * double slash out of the result, and an empty concatenation is the site
 * root.
 */
export function composeRoutePath(layoutPrefix: string, routePath: string): string {
  const normalizedPrefix = layoutPrefix === "/" ? "" : layoutPrefix.replace(/\/+$/, "");
  const normalizedRoute = routePath === "/" ? "" : routePath;
  const composed = `${normalizedPrefix}${normalizedRoute}`;

  return composed === "" ? "/" : composed;
}
