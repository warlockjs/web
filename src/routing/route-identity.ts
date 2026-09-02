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
 * source path (e.g. `"src/web/index.page.tsx"`).
 *
 * {@link canonicalizeRouteExport} is also the ONE seam every declared
 * `route.path` passes through on its way into either installer
 * (`install-page-routes.ts`, `install-page-routes-from-manifest.ts`), so it is
 * where `../routing/page-route-grammar.ts`'s `classifyPageRoutePath` is
 * applied: a rejected path raises {@link PageRoutePathNotSupportedError}
 * naming the offending page file, rather than being published literally.
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
import { classifyPageRoutePath, PageRoutePathNotSupportedError } from "./page-route-grammar";

/**
 * A page's opt-in into shared-cache storage for its document AND its data
 * representation (`x-warlock-data`) — the two must never diverge, because a
 * cacheable data payload leaks exactly what an uncacheable document was
 * protecting (`../server/create-page-route-handler.ts`).
 *
 * `public: true` is not a flag with a `false` counterpart: the framework is
 * closed by default (`../server/response-cache-floor.ts`), so the only
 * meaningful state this object can express is "yes, cache me" — a page that
 * wants the default simply omits `cache` entirely. `maxAge` has no framework
 * default and never will: a route's freshness window is a decision only the
 * route's author can make safely, and guessing one would be exactly the kind
 * of silent, environment-dependent behaviour this feature exists to remove.
 * Both keys are required — see {@link InvalidPageCacheOptInError}.
 *
 * Shaped as an object, not a boolean or a bare number, so a later addition
 * (e.g. CDN surrogate keys) extends it without a breaking change.
 */
export type PageCacheOptIn = {
  public: true;
  /** Freshness window in seconds, emitted as `Cache-Control: public, max-age=<maxAge>`. */
  maxAge: number;
};

/** The shape a page's `route` export may declare — mirrors `PageRouteExport` in `install-page-routes.ts`. */
export type DeclaredRouteExport = string | { path: string; name?: string; cache?: PageCacheOptIn };

/** The canonical form every declared `route` export resolves to. */
export type CanonicalRoute = {
  path: string;
  name?: string;
};

/**
 * Raised when a page's `route.cache` is present but malformed — most notably
 * `public: true` with no `maxAge`. The framework refuses to invent a
 * freshness window (see {@link PageCacheOptIn}), so this is a BOOT-TIME
 * failure rather than a silent fallback to `no-store`: a developer who wrote
 * `cache: { public: true }` meant for the route to be cacheable, and serving
 * it `no-store` without a word would be the exact silent-failure class this
 * release exists to kill.
 */
export class InvalidPageCacheOptInError extends Error {
  public constructor(public readonly pageFile: string) {
    super(
      `"${pageFile}" declares \`route.cache\` without a valid opt-in. Both keys are required: ` +
        "write `cache: { public: true, maxAge: <seconds> }` — for example `cache: { public: " +
        "true, maxAge: 60 }`. Remove `cache` entirely to keep the route `no-store` (the default) " +
        "instead.",
    );
    this.name = "InvalidPageCacheOptInError";
  }
}

/**
 * Resolves and validates a declared `route` export's `cache` opt-in.
 *
 * `undefined` — the common case — means "no opt-in", which the caller (the
 * response-cache-floor seam) treats as `no-store`, not as "cacheable with no
 * limit". A malformed opt-in throws {@link InvalidPageCacheOptInError} rather
 * than being coerced or ignored, so a typo in a route's `cache` field fails
 * the build/boot instead of quietly shipping an unintended cache policy.
 */
export function resolvePageRouteCache(
  route: DeclaredRouteExport | undefined,
  pageFile: string,
): PageCacheOptIn | undefined {
  if (route === undefined || typeof route === "string") return undefined;

  const { cache } = route;

  if (cache === undefined) return undefined;

  if (cache.public !== true || typeof cache.maxAge !== "number") {
    throw new InvalidPageCacheOptInError(pageFile);
  }

  return cache;
}

/**
 * Canonicalizes a declared `route` export — string or `{ path, name? }` —
 * into `{ path, name? }`. Requires well-formed input; an export that is
 * neither a string nor an object with a `path` is the extractor's problem,
 * already rejected before this function is ever called.
 *
 * This is also where the declared `path` is validated: `pageFile` names the
 * page whose `route` export is being canonicalized, and a `path` that
 * {@link classifyPageRoutePath} rejects raises
 * {@link PageRoutePathNotSupportedError} naming it — rather than being
 * published literally. Both installers reach every declared path through
 * here, so this is the one place that check has to live.
 */
export function canonicalizeRouteExport(
  route: DeclaredRouteExport,
  pageFile: string,
): CanonicalRoute {
  const path = typeof route === "string" ? route : route.path;
  const verdict = classifyPageRoutePath(path);

  if (verdict.type === "rejected") {
    throw new PageRoutePathNotSupportedError(pageFile, path, verdict.reason);
  }

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

  return canonicalizeRouteExport(route, pageFile).name ?? deriveFilesystemRouteName(pageFile);
}
