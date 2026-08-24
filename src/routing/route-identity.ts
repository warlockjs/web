/**
 * Route identity — the single, pure implementation of "what is this page's
 * route path and name". The dev installer
 * (`web/src/server/install-page-routes.ts`), the production manifest
 * installer (`web/src/server/install-page-routes-from-manifest.ts`) and
 * discovery (`web/src/build/discover-pages.ts`) each hand-derived this on
 * their own until all three were made to delegate here.
 *
 * Pure string logic only: no `fs`, no `path`, no Node built-ins. Every input
 * this module accepts is already CANONICAL — a POSIX, app-root-relative
 * source path (e.g. `"src/app/users/web/account/settings.page.tsx"` or
 * `"src/web/index.page.tsx"`) and an already-validated declared route export.
 * Turning an absolute, OS-specific file path into that canonical form is the
 * caller's job; this module refuses (see {@link NonPosixSourceFilePathError})
 * rather than guess at a normalization.
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

/** The shape a page's `route` export may declare — mirrors `PageRouteExport` in `install-page-routes.ts`. */
export type DeclaredRouteExport = string | { path: string; name?: string };

/** The canonical form every declared `route` export resolves to. */
export type CanonicalRoute = {
  path: string;
  name?: string;
};

/** The canonical inputs {@link deriveFallbackRouteName} requires — see the module doc comment for what "canonical" means. */
export type RouteNameFallbackInput = {
  /** The page's declared route path, e.g. `"/settings"` or `"/"`. */
  routePath: string;
  /** The page's app-root-relative POSIX source path, e.g. `"src/app/main/web/contact-us.page.tsx"`. */
  sourceFile: string;
};

/**
 * Raised when a caller passes a `sourceFile` containing a backslash.
 * Canonical means canonical: this module does not normalize Windows path
 * separators on the caller's behalf.
 */
export class NonPosixSourceFilePathError extends Error {
  public constructor(public readonly sourceFile: string) {
    super(
      `route-identity: sourceFile "${sourceFile}" contains a backslash. This module's inputs ` +
        "must already be canonical app-root-relative POSIX paths (forward slashes only) — " +
        'normalize with `value.replace(/\\\\/g, "/")` before calling deriveFallbackRouteName.',
    );
    this.name = "NonPosixSourceFilePathError";
  }
}

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

/** Strips leading and trailing "." characters — mirrors `trim(value, ".")` as used by the installer's `deriveRouteName`. */
function trimDots(value: string): string {
  return value.replace(/^\.+|\.+$/g, "");
}

/**
 * The module segment a canonical source path declares, or `undefined` for a
 * global (`src/web/**`) page. `sourceFile` is `<srcDir>/app/<module>/web/...`
 * or `<srcDir>/web/...` — the first segment is the (arbitrarily named) src
 * dir, so the module test looks at the SECOND segment.
 */
function moduleSegmentFor(sourceFile: string): string | undefined {
  const segments = sourceFile.split("/");

  return segments[1] === "app" ? segments[2] : undefined;
}

/**
 * Derives the fallback route name for a page whose declared route carries no
 * `name` — the same derivation the dev installer's `deriveRouteName` applies
 * today (`web/src/server/install-page-routes.ts`), expressed against
 * canonical inputs instead of an absolute file path plus an `appSrcRoot`.
 *
 * The installer only ever calls its derivation for a page under
 * `<appSrcRoot>/app/**`, so a global (`src/web/**`) page has no installer
 * behaviour to mirror; for that case this function instead follows
 * discovery's own convention (`routeNameFor` in `discover-pages.ts`) — no
 * module prefix, and `"index"` when there is nothing left to say at all.
 *
 * Throws {@link NonPosixSourceFilePathError} when `sourceFile` contains a
 * backslash.
 */
export function deriveFallbackRouteName(input: RouteNameFallbackInput): string {
  const { routePath, sourceFile } = input;

  if (sourceFile.includes("\\")) {
    throw new NonPosixSourceFilePathError(sourceFile);
  }

  const moduleName = moduleSegmentFor(sourceFile);
  const suffix = trimDots(routePath.replace(/\//g, "."));

  if (moduleName !== undefined) {
    return suffix ? `${moduleName}.${suffix}` : moduleName;
  }

  return suffix || "index";
}
