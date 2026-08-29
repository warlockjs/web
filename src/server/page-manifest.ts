/**
 * The build→runtime handoff table for production pages.
 *
 * The generated `<productionDir>/pages.ts` barrel — written by
 * `web/src/build/generate-pages-barrel.ts` — statically imports every page,
 * layout and the app root, then calls {@link providePageManifest} exactly
 * once. The connector reads it back at boot with {@link consumePageManifest}.
 *
 * DEPENDENCY-FREE ON PURPOSE: this module is re-exported from web's root
 * barrel (`web/src/index.ts`) so the generated barrel — which lives in the
 * consuming app's production dir — can reach it by package specifier. Adding
 * an import here would add that import to every app that loads
 * `@warlock.js/web`.
 *
 * Entries carry MODULES + FILESYSTEM FACTS ONLY — never route paths. A page's
 * route is read off its module (`route` export) at boot and, when present,
 * composed with its layout `prefix`; when absent, the path is instead derived
 * from the page's own `sourceFile` and its layouts' prefixes, exactly as
 * `install-page-routes.ts:377-382` does in dev and `discover-pages.ts:925-935`
 * does at build — so explicit-wins semantics live in one place for all three.
 */

export type PageManifestLayoutEntry = {
  /** The imported layout module namespace object (default export = component, optional `prefix`). */
  module: Record<string, unknown>;
  /** App-root-relative POSIX source path, e.g. "src/web/layout.tsx". */
  sourceFile: string;
};

export type PageManifestPageEntry = {
  /** The imported page module namespace object (default export = component, optional `route`). */
  module: Record<string, unknown>;
  /**
   * App-root-relative POSIX source path, e.g. "src/web/home.page.tsx"
   * — feeds FS-derived route/name fallback. The anchor is the APP ROOT, not the
   * repo root; the two differ the moment the app does not sit at the repo root.
   * Consumers compare these ids VERBATIM — the barrel that wrote them is the
   * authority on their form, and re-resolving or normalising one on the way in
   * turns a lookup miss into a silent mis-match.
   */
  sourceFile: string;
  /** Layout chain, outermost first. */
  layouts: readonly PageManifestLayoutEntry[];
};

/** The optional application error boundary, kept outside the routable page table. */
export type PageManifestErrorPageEntry = {
  module: Record<string, unknown>;
  sourceFile: string;
};

export type PageManifest = {
  /**
   * Where the client bundle was written, as an APP-ROOT-RELATIVE POSIX path
   * (`"dist/client"`). Resolved against the process cwd at boot, the same
   * anchor `sourceFile` uses.
   *
   * BAKED AT BUILD TIME because the runtime has no other way to learn it. The
   * directory is `<build.outdir>/client`, and `build.outdir` is configurable —
   * but it lives in `warlock.config.ts`, a BUILD-TIME file that is never
   * shipped and cannot be loaded by the plain `node dist/app.js` process
   * `warlock start` spawns. Reading it at runtime through
   * `resolveBuildConfig()` is what used to throw
   * `WarlockConfig not loaded` during connector boot, taking the whole server
   * down before it could listen.
   *
   * OPTIONAL for the same reason `app` is: a zero-page build skips the client
   * bundle entirely, so there is no directory to name. Present whenever
   * `pages` is non-empty.
   */
  clientDir?: string;
  /**
   * The application root component every page renders inside.
   *
   * OPTIONAL because it is only meaningful when pages exist: a build that
   * discovered zero pages provides `{ pages: [] }` and has no root to wrap
   * anything in. The build enforces the other direction — pages without an
   * app root fail generation — so `app` absent means `pages` is empty. Callers
   * must still branch on `pages.length` before reading `app`: the invariant is
   * the generator's, and a consumer that assumes it without checking turns a
   * malformed manifest into a crash deep in rendering instead of a named error.
   */
  app?: { module: Record<string, unknown>; sourceFile: string };
  /** An application-owned error boundary. It has no route name or path. */
  errorPage?: PageManifestErrorPageEntry;
  /**
   * The page table. EMPTY IS A REAL STATE, not a missing one: an empty array
   * means "this bundle was built with web, and it has no pages", which is what
   * separates it from {@link consumePageManifest} returning `undefined`.
   */
  pages: readonly PageManifestPageEntry[];
};

let providedManifest: PageManifest | undefined;

/**
 * Called exactly once by the generated production/pages.ts barrel.
 *
 * A second call throws: two barrels in one process means either a stale
 * generated file survived into the bundle or the build ran twice, and the
 * second table silently replacing the first is precisely the drift this
 * contract exists to make impossible.
 */
export function providePageManifest(manifest: PageManifest): void {
  if (providedManifest !== undefined) {
    throw new Error(
      "providePageManifest: a page manifest was already provided " +
        "(web/src/server/page-manifest.ts). The generated production/pages.ts barrel " +
        "must run exactly once per process.",
    );
  }

  providedManifest = manifest;
}

/**
 * Connector-side read (WebConnector.boot, prod mode).
 *
 * `undefined` = no barrel ran → the app was not built with web. A manifest
 * whose `pages` is empty is the OTHER answer — built with web, no pages — and
 * the two are deliberately distinguishable here rather than collapsed into one
 * falsy result. The registry itself never throws on absence — absence is a
 * fact, not an error; the connector branches on MODE (prod: boot error; dev:
 * normal) so `undefined` never means two things at one call site.
 */
export function consumePageManifest(): PageManifest | undefined {
  return providedManifest;
}
