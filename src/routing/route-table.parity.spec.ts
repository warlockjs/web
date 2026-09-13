/**
 * UMBRELLA PARITY GATE — dev and production agree on a page's whole
 * `{ path, name }` route table, INCLUDING layout-prefix composition.
 *
 * `route-name-parity.spec.ts` pins the NAME half of one page. This is the rest
 * of the table: for a fixture set that spans every route shape a page can take
 * — an index page, an explicitly named page, a dynamic `[param]` page, a page
 * whose URL is renamed by a layout `prefix`, a `(group)` folder that must not
 * contribute a segment, and a terminal catch-all — it derives the FULL route
 * the PRODUCTION manifest installer would register and the FULL route the DEV
 * installer would register, and asserts they are byte-for-byte identical.
 *
 * The two derivations it pins against each other:
 *
 *   PRODUCTION — `resolveRoute` (`../server/install-page-routes-from-manifest.ts`),
 *     the manifest installer's own route-identity wrapper, plus the exact
 *     effective-path composition its registration loop performs
 *     (`install-page-routes-from-manifest.ts:341-347`).
 *   SHARED (what DEV uses) — `resolvePageRouteIdentity` (`./route-identity.ts`),
 *     called the way dev's installer calls it
 *     (`install-page-routes.ts:495-516`), plus the same composition.
 *
 * Both installers reach `composeRoutePath` / `deriveFilesystemRoutePath`
 * (`./compose-route-path.ts`, `./filesystem-route.ts`) identically, so this
 * calls them identically on both sides too: the effective-path step is shared
 * code, and what this gate watches is that production's identity derivation and
 * the shared one it delegates to never re-split. If someone were to give
 * production its own name/path derivation again — the b8e6ede3 dev/prod
 * pipeline-drift shape, whose sharpest instance is a renamed `route.path` whose
 * NAME silently comes from the file path in one mode and the declared path in
 * the other (the 428ed59 "/about/ production 404" red) — the two tables would
 * disagree here and this spec would go loudly red.
 *
 * PURE: `web/src/routing/` bans `node:fs`, `node:path`, `vite` and `fastify`,
 * so nothing is discovered or loaded. Every fixture hands the derivations
 * hand-built `PageRouteExport` values and canonical, POSIX, app-root-relative
 * source-path strings — the same canonical inputs both installers feed these
 * functions. Runs in milliseconds.
 */
import { describe, expect, it } from "vitest";
import { resolveRoute } from "../server/install-page-routes-from-manifest";
import type { PageRouteExport } from "../server/install-page-routes";
import { composeRoutePath } from "./compose-route-path";
import { deriveFilesystemRoutePath } from "./filesystem-route";
import { resolvePageRouteIdentity } from "./route-identity";

/** One page's resolved route table entry — the pair both modes must agree on. */
type RouteTableEntry = {
  path: string;
  name: string;
};

/**
 * One fixture page, expressed in the canonical inputs both installers already
 * compute for a page before deriving its route.
 */
type PageFixture = {
  label: string;
  /**
   * The page's manifest `sourceFile`: POSIX, app-root-relative, `"src/web/..."`
   * — exactly what production's `resolveRoute` takes and what dev canonicalizes
   * a discovered page file to.
   */
  sourceFile: string;
  /** The page's `route` export, or `undefined` for a filesystem-derived route. */
  route: PageRouteExport | undefined;
  /**
   * The layouts' `prefix`es keyed by their web-root-relative directory (root is
   * `""`) — the table `deriveFilesystemRoutePath` consults when the page
   * declares no `route`, matching the manifest installer's `layoutPrefixesOf`.
   */
  layoutPrefixes: Readonly<Record<string, string>>;
  /**
   * The composed layout prefix `composeRoutePath` folds a DECLARED `route.path`
   * into — the single string both installers hold as `layoutPrefix` after
   * collapsing the chain. `"/"` when no layout contributes one.
   */
  layoutPrefix: string;
  /** The one route table entry both modes must agree on. */
  expected: RouteTableEntry;
};

/**
 * `sourceFile`'s path relative to the web root, mirroring the manifest
 * installer's own private `webRelativeSourceFile`
 * (`install-page-routes-from-manifest.ts:117`): drop `<srcDir>` and the literal
 * `web` segment. This is the value both installers feed the filesystem
 * derivations as `pageFile`.
 */
function webRelativeSourceFile(sourceFile: string): string {
  return sourceFile.split("/").slice(2).join("/");
}

/**
 * PRODUCTION's route table entry for one page — `resolveRoute` for identity,
 * then the manifest installer's own effective-path branch
 * (`install-page-routes-from-manifest.ts:341-347`).
 */
function productionRoute(fixture: PageFixture): RouteTableEntry {
  const { path: routePath, name } = resolveRoute(fixture.route, fixture.sourceFile);

  const path =
    fixture.route === undefined
      ? deriveFilesystemRoutePath({
          pageFile: webRelativeSourceFile(fixture.sourceFile),
          layoutPrefixes: fixture.layoutPrefixes,
        })
      : composeRoutePath(fixture.layoutPrefix, routePath);

  return { path, name };
}

/**
 * The SHARED rule DEV uses for one page — `resolvePageRouteIdentity` for
 * identity, then the dev installer's own effective-path branch
 * (`install-page-routes.ts:495-516`). Dev feeds the web-relative page file as
 * `pageFile` and the source file as the rejected-path error context.
 */
function sharedRoute(fixture: PageFixture): RouteTableEntry {
  const pageFile = webRelativeSourceFile(fixture.sourceFile);
  const { path: routePath, name } = resolvePageRouteIdentity(
    fixture.route,
    pageFile,
    fixture.sourceFile,
  );

  const path =
    fixture.route === undefined
      ? deriveFilesystemRoutePath({ pageFile, layoutPrefixes: fixture.layoutPrefixes })
      : composeRoutePath(fixture.layoutPrefix, routePath);

  return { path, name };
}

const FIXTURES: readonly PageFixture[] = [
  {
    label: "an index page resolves to the site root",
    sourceFile: "src/web/index.page.tsx",
    route: undefined,
    layoutPrefixes: {},
    layoutPrefix: "/",
    expected: { path: "/", name: "index" },
  },
  {
    label: "an explicitly named page keeps its declared path and name",
    sourceFile: "src/web/blog/archive.page.tsx",
    route: { path: "/blog", name: "journal" },
    layoutPrefixes: {},
    layoutPrefix: "/",
    expected: { path: "/blog", name: "journal" },
  },
  {
    label: "a dynamic [param] page becomes a :param segment",
    sourceFile: "src/web/users/[id].page.tsx",
    route: undefined,
    layoutPrefixes: {},
    layoutPrefix: "/",
    expected: { path: "/users/:id", name: "users.id" },
  },
  {
    label: "a filesystem-derived page inherits a layout prefix in its URL, not its name",
    sourceFile: "src/web/dashboard/settings.page.tsx",
    route: undefined,
    layoutPrefixes: { dashboard: "/admin/panel" },
    layoutPrefix: "/admin/panel",
    expected: { path: "/admin/panel/settings", name: "dashboard.settings" },
  },
  {
    label: "a declared-path page composes with its layout prefix",
    sourceFile: "src/web/shop/deals.page.tsx",
    route: { path: "/deals" },
    layoutPrefixes: {},
    layoutPrefix: "/shop-front",
    expected: { path: "/shop-front/deals", name: "shop.deals" },
  },
  {
    label: "a (group) folder contributes nothing to the path or the name",
    sourceFile: "src/web/(marketing)/about.page.tsx",
    route: undefined,
    layoutPrefixes: {},
    layoutPrefix: "/",
    expected: { path: "/about", name: "about" },
  },
  {
    label: "a terminal catch-all keeps its wildcard and its filesystem name",
    sourceFile: "src/web/files/index.page.tsx",
    route: { path: "/files/*" },
    layoutPrefixes: {},
    layoutPrefix: "/",
    expected: { path: "/files/*", name: "files" },
  },
  {
    // The 428ed59 shape: a page whose URL is renamed via `route.path` but which
    // declares no `name`. Its name MUST stay the file-path name on both sides —
    // deriving it from the declared path is exactly the re-split this gate
    // watches for (see the module doc comment and the RED control below).
    label: "a renamed path keeps its file-path name, not a name derived from the URL",
    sourceFile: "src/web/blog/archive.page.tsx",
    route: { path: "/renamed-url" },
    layoutPrefixes: {},
    layoutPrefix: "/",
    expected: { path: "/renamed-url", name: "blog.archive" },
  },
];

describe("route table parity — production derivation equals the shared rule dev uses", () => {
  it.each(FIXTURES.map((fixture) => [fixture.label, fixture] as const))(
    "agrees on { path, name } for %s",
    (_label, fixture) => {
      const production = productionRoute(fixture);
      const shared = sharedRoute(fixture);

      expect(production).toEqual(shared);
      expect(production).toEqual(fixture.expected);
    },
  );

  it("agrees on the WHOLE route table at once, not just per page", () => {
    const productionTable = FIXTURES.map(productionRoute);
    const sharedTable = FIXTURES.map(sharedRoute);

    expect(productionTable).toEqual(sharedTable);
    expect(productionTable).toEqual(FIXTURES.map((fixture) => fixture.expected));
  });
});
