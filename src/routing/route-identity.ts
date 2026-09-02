/**
 * Route identity — the single, pure implementation of "what is this page's
 * route path and name". The dev installer
 * (`web/src/server/install-page-routes.ts`), the production manifest
 * installer (`web/src/server/install-page-routes-from-manifest.ts`) and
 * discovery (`web/src/build/discover-pages.ts`) each hand-derived this on
 * their own until all three were made to delegate here.
 *
 * {@link resolvePageRouteName} is the ONE answer to "what is this page's
 * route name": an explicit `name` on the declared `route` export wins,
 * otherwise the name comes from the page's own FILE PATH
 * (`deriveFilesystemRouteName`) — never from `route.path`. The route name is
 * an identity key (`routing/route-table.ts`'s lookup key, `components/link.ts`,
 * `server/render-page.ts`, the generated client registry and the hydration
 * payload all address a page by it), and an identity key must be stable under
 * the change most likely to happen to a page — its URL, renamed for SEO,
 * localization or restructuring. A file path is also unique by construction,
 * while a declared `path: "/"` yields no usable name at all.
 *
 * Pure string logic only: no `fs`, no `path`, no Node built-ins. Every input
 * this module accepts is already CANONICAL — a POSIX, app-root-relative
 * source path (e.g. `"src/web/index.page.tsx"`) and an already-validated
 * declared route export.
 *
 * Well-formedness of the declared `route` export itself (is it a string or an
 * object, does the object have a `path`) is the extractor's problem — already
 * rejected at build before either derivation function here is called.
 *
 * DIRECTORY CONTRACT — applies to everything in `web/src/routing/`: nothing
 * here may import `node:fs`, `node:path`, `vite`, or `fastify`. Modules in
 * this directory receive canonical values and trust nothing — they assert
 * rather than trust, but they never repair. A module that needs the
 * filesystem does not belong here. The purity is deliberate: it keeps these
 * modules consumable from the dev server, the build, the production runtime,
 * and — if ever needed — the browser client, without dragging any of those
 * environments along.
 */

import { deriveFilesystemRouteName } from "./filesystem-route";

/** The shape a page's `route` export may declare — mirrors `PageRouteExport` in `install-page-routes.ts`. */
export type DeclaredRouteExport = string | { path: string; name?: string };

/** The canonical form every declared `route` export resolves to. */
export type CanonicalRoute = {
  path: string;
  name?: string;
};

/**
 * Canonicalizes a declared `route` export — string or `{ path, name? }` —
 * into `{ path, name? }`. Requires well-formed input; an export that is
 * neither a string nor an object with a `path` is the extractor's problem,
 * already rejected before this function is ever called.
 */
export function canonicalizeRouteExport(route: DeclaredRouteExport): CanonicalRoute {
  if (typeof route === "string") {
    return { path: route };
  }

  return route.name === undefined ? { path: route.path } : { path: route.path, name: route.name };
}

/**
 * Resolves a page's route NAME — the single derivation `install-page-routes.ts`,
 * `install-page-routes-from-manifest.ts` and `discover-pages.ts` all delegate
 * to, so dev, the production manifest installer and build discovery cannot
 * derive three different names for the same page (see the module doc comment
 * for why the file path, not `route.path`, is the source of truth).
 *
 * An explicit `name` on `route` always wins. Otherwise the name is derived
 * from `pageFile` via {@link deriveFilesystemRouteName} — `pageFile` must
 * already be canonical: a POSIX path relative to the page's web root (e.g.
 * `"blog/archive.page.tsx"`), the same value each caller already computes as
 * `filesystemPageFileFor`/`webRelativeSourceFile`/`relativePageFile`.
 */
export function resolvePageRouteName(
  route: DeclaredRouteExport | undefined,
  pageFile: string,
): string {
  if (route === undefined) {
    return deriveFilesystemRouteName(pageFile);
  }

  return canonicalizeRouteExport(route).name ?? deriveFilesystemRouteName(pageFile);
}
