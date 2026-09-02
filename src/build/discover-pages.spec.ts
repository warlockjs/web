import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
import { PageRoutePathNotSupportedError } from "../routing/page-route-grammar";
import {
  discoverPages as discoverPagesRaw,
  DuplicateErrorPageError,
  DuplicatePageRouteNameError,
  DuplicatePageRoutePathError,
  ErrorPageDeclaresRouteError,
  isDiscoveredRoutablePage,
  UnknownMetadataKeyError,
  type DiscoverPagesOptions,
  type DiscoveredRoutablePage,
} from "./discover-pages";
import { NotFoundPageDeclaresRouteError } from "../server/not-found-page";
import { MissingPageDefaultExportError } from "./page-default-export";
import { NonLiteralRouteExportError } from "./read-route-exports";

/**
 * None of this file's fixtures declare an `error.page.tsx`, so every result
 * {@link discoverPagesRaw} returns here is the routable half of its union —
 * narrowed once, at the one call site every test shares, rather than at each
 * of the dozens of assertions that read `.routePath` / `.routeName` /
 * `.layouts` and would otherwise fail to type-check against the union.
 */
function discoverPages(options: DiscoverPagesOptions): DiscoveredRoutablePage[] {
  return discoverPagesRaw(options).filter(isDiscoveredRoutablePage);
}

const temporaryDirectories: string[] = [];

/** Materialises a fixture app tree: `{ "src/web/root.tsx": "…" }` under a temp root. */
function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-discover-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

const APP = "export default function App() { return null; }\n";
const LAYOUT = "export default function Layout() { return null; }\n";

/** A page module declaring `declaration` verbatim above its default export. */
function pageDeclaring(declaration: string): string {
  return `${declaration}\nexport default function Page() { return null; }\n`;
}

/** A layout module declaring `declaration` verbatim above its default export. */
function layoutDeclaring(declaration: string): string {
  return `${declaration}\nexport default function Layout() { return null; }\n`;
}

/**
 * A layout that renders NOTHING: named exports only, no default export.
 *
 * The shape `v5/app`'s `users/web/account/layout.tsx` already uses — a `prefix`
 * and an authorization `middleware`, deliberately placed so every page added
 * beneath it is gated whether or not its author remembers. It adds no element
 * to the DOM, so it is not a second wrapper and the single-layout rule must not
 * count it as one.
 */
function nonRenderingLayout(declaration: string): string {
  return `${declaration}\n`;
}

/**
 * A page declaring the bare-string `route` shorthand.
 *
 * Explicit-route fixtures use this helper; route-less fixtures exercise the
 * filesystem convention directly.
 */
function routed(routePath: string): string {
  return pageDeclaring(`export const route = ${JSON.stringify(routePath)};`);
}

/** App-relative POSIX paths, so expectations read like the tree the fixture declared. */
function relative(appRoot: string, files: readonly string[]): string[] {
  return files.map((file) => path.relative(appRoot, file).replace(/\\/g, "/"));
}

/**
 * Runs `discover` with every directory listing handed back REVERSED.
 *
 * The point of the mock: a real temp directory tends to enumerate in creation
 * or name order, so a scan that happens to depend on enumeration order looks
 * deterministic on the machine that wrote it. Reversing every listing is the
 * cheapest way to make that dependency visible.
 */
function withReversedDirectoryListings<T>(discover: () => T): T {
  const readdirSync = fs.readdirSync as unknown as (
    dir: string,
    options: { withFileTypes: true },
  ) => fs.Dirent[];

  const spy = vi
    .spyOn(fs, "readdirSync")
    .mockImplementation(((dir: string, options: { withFileTypes: true }) =>
      [...readdirSync(dir, options)].reverse()) as typeof fs.readdirSync);

  try {
    return discover();
  } finally {
    spy.mockRestore();
  }
}

describe("discoverPages — the recipe", () => {
  it("carries the page, its (single) layout chain, and the app root", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/account/layout.tsx": LAYOUT,
      "src/web/users/account/settings.page.tsx": routed("/account/settings"),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    expect(relative(appRoot, [page.pageFile])).toEqual([
      "src/web/users/account/settings.page.tsx",
    ]);
    expect(relative(appRoot, page.layouts)).toEqual(["src/web/users/account/layout.tsx"]);
    expect(relative(appRoot, [page.appFile as string])).toEqual(["src/web/root.tsx"]);
    expect(page.routePath).toBe("/account/settings");
    // The name is the file path, not the declared route path: "users" is a
    // directory segment even though `route` never mentions it.
    expect(page.routeName).toBe("users.account.settings");
  });

  it("discovers src/web pages and ignores page-like files under src/app", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/layout.tsx": LAYOUT,
      "src/web/dashboard.page.tsx": routed("/dashboard"),
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": routed("/account/settings"),
    });

    const pages = discoverPages({ appRoot });

    expect(relative(appRoot, pages.map((page) => page.pageFile)).sort()).toEqual([
      "src/web/dashboard.page.tsx",
    ]);

    const dashboard = pages.find((page) => page.routeName === "dashboard");

    expect(relative(appRoot, dashboard?.layouts ?? [])).toEqual(["src/web/layout.tsx"]);
  });

  it("leaves `appFile` unset when there is no root.tsx — that verdict belongs to the consumer", () => {
    const appRoot = makeAppTree({ "src/web/home.page.tsx": routed("/home") });

    const [page] = discoverPages({ appRoot });

    expect(page.appFile).toBeUndefined();
    expect(page.routeName).toBe("home");
  });

  it("derives an undeclared name from the file path, never the declared path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/index.page.tsx": routed("/"),
      "src/web/shop/items/index.page.tsx": routed("/items"),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.map((page) => [page.routePath, page.routeName])).toEqual([
      ["/", "shop"],
      ["/items", "shop.items"],
    ]);
  });

  it("yields [] for an empty tree", () => {
    expect(discoverPages({ appRoot: makeAppTree({}) })).toEqual([]);
    expect(discoverPages({ appRoot: makeAppTree({ "src/web/root.tsx": APP }) })).toEqual([]);
  });

  it("honours `srcDir`", () => {
    const appRoot = makeAppTree({
      "source/web/root.tsx": APP,
      "source/web/about.page.tsx": routed("/about"),
      "src/web/decoy.page.tsx": routed("/decoy"),
    });

    const pages = discoverPages({ appRoot, srcDir: "source" });

    expect(pages.map((page) => page.routeName)).toEqual(["about"]);
  });
});

describe("discoverPages — every page renders a default export", () => {
  it.each(["home.page.tsx", "404.page.tsx", "error.page.tsx"])(
    "refuses %s when it contains named exports only",
    (fileName) => {
      const appRoot = makeAppTree({
        "src/web/root.tsx": APP,
        [`src/web/${fileName}`]: 'export const marker = "named-only";\n',
      });

      try {
        discoverPagesRaw({ appRoot });
        expect.unreachable("expected discovery to reject a page without a default export");
      } catch (error) {
        expect(error).toBeInstanceOf(MissingPageDefaultExportError);
        expect((error as Error).message).toContain(`src/web/${fileName}`);
        expect((error as Error).message).toContain("export default function Page()");
      }
    },
  );

  it("accepts a runtime binding re-exported as default", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/home.page.tsx":
        "function Home() { return null; }\nexport { Home as default };\n",
    });

    expect(discoverPages({ appRoot }).map((page) => page.routePath)).toEqual(["/home"]);
  });

  it("refuses a type-only default export because it has no runtime component", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/home.page.tsx": "export default interface HomePage {}\n",
    });

    expect(() => discoverPagesRaw({ appRoot })).toThrow(MissingPageDefaultExportError);
  });
});

describe("discoverPages — property A: a defined total order", () => {
  it("sorts lexicographically by SOURCE FILE PATH, never by route path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/index.page.tsx": routed("/z-last"),
      "src/web/shop/items/detail.page.tsx": routed("/a-first"),
      "src/web/about.page.tsx": routed("/m-middle"),
    });

    const pages = discoverPages({ appRoot });

    // Route-path order would be /a-first, /m-middle, /z-last. The file decides:
    // a page's route is one line an author can rewrite, and reordering the whole
    // artefact on that edit is churn nobody asked for.
    expect(relative(appRoot, pages.map((page) => page.pageFile))).toEqual([
      "src/web/about.page.tsx",
      "src/web/shop/index.page.tsx",
      "src/web/shop/items/detail.page.tsx",
    ]);
    expect(pages.map((page) => page.routePath)).toEqual(["/m-middle", "/z-last", "/a-first"]);
  });

  it("still orders two pages that declare the SAME route path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/zebra.page.tsx": routed("/zebra"),
      "src/web/alpha.page.tsx": routed("/alpha"),
      // Two files declare one route path — only the file path separates them.
      "src/web/list.page.tsx": routed("/list"),
      "src/web/users/list.page.tsx": pageDeclaring(
        'export const route = { path: "/list", name: "users.list" };',
      ),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.map((page) => [page.routePath, page.routeName])).toEqual([
      ["/alpha", "alpha"],
      ["/list", "list"],
      ["/list", "users.list"],
      ["/zebra", "zebra"],
    ]);
  });

  it("gives a parameter segment no rank of its own — `[` simply sorts before `p`", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/[id].page.tsx": routed("/[id]"),
      "src/web/users/profile.page.tsx": routed("/profile"),
    });

    // `/profile` matches ahead of `/[id]` at runtime, and this array says the
    // opposite: the order is serialization, and reading precedence out of it
    // is the mistake this fixture exists to make impossible to sustain.
    expect(discoverPages({ appRoot }).map((page) => page.routePath)).toEqual([
      "/[id]",
      "/profile",
    ]);
  });

  it("returns the identical order under reversed directory enumeration", () => {
    const files = {
      "src/web/root.tsx": APP,
      "src/web/shop/index.page.tsx": routed("/"),
      "src/web/shop/items/detail.page.tsx": routed("/items/detail"),
      "src/web/shop/items/summary.page.tsx": routed("/items/summary"),
      "src/web/about.page.tsx": routed("/about"),
      "src/web/contact.page.tsx": routed("/contact"),
    };

    const forwardRoot = makeAppTree(files);
    const reversedRoot = makeAppTree(files);

    const forward = discoverPages({ appRoot: forwardRoot });
    const reversed = withReversedDirectoryListings(() =>
      discoverPages({ appRoot: reversedRoot }),
    );

    expect(reversed.map((page) => page.routeName)).toEqual(
      forward.map((page) => page.routeName),
    );
    expect(relative(reversedRoot, reversed.map((page) => page.pageFile))).toEqual(
      relative(forwardRoot, forward.map((page) => page.pageFile)),
    );
  });
});

describe("discoverPages — property B: one route name, one page", () => {
  it("throws naming BOTH files and the shared name", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/reports/list.page.tsx": pageDeclaring(
        'export const route = { path: "/reports/list", name: "users.list" };',
      ),
      "src/web/users/list.page.tsx": pageDeclaring(
        'export const route = { path: "/list", name: "users.list" };',
      ),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the duplicate route name");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicatePageRouteNameError);

      const message = (error as Error).message;

      expect(message).toContain("users.list");
      expect(message).toContain("src/web/users/list.page.tsx");
      expect(message).toContain("src/web/users/list.page.tsx");
      // The message has to stand on its own for an app author: what collided,
      // what it costs them, and what to change.
      expect(message).toContain("would be unreachable");
      expect(message).toContain("To fix: rename one of the files");
    }
  });

  it("lets two pages share a route PATH when their names differ", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/list.page.tsx": routed("/list"),
      "src/web/users/list.page.tsx": pageDeclaring(
        'export const route = { path: "/list", name: "users.list" };',
      ),
    });

    expect(discoverPages({ appRoot }).map((page) => page.routeName)).toEqual([
      "list",
      "users.list",
    ]);
  });
});

describe("discoverPages — property C: the canonical route is the DECLARED one", () => {
  it("(a) takes the declared route path over the filesystem-derived one", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/list.page.tsx": pageDeclaring(
        'export const route = "/people/directory";',
      ),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    expect(page.routePath).toBe("/people/directory");
    // The name still comes from the file path — an identity key must stay
    // stable when the URL is restructured, so the declared path wins the
    // route but never the name.
    expect(page.routeName).toBe("users.list");
  });

  it("(b) refuses a computed route export, naming the file, before returning anything", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/list.page.tsx": pageDeclaring(
        'import { buildRoute } from "./routes";\nexport const route = buildRoute("/list");',
      ),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the computed route export");
    } catch (error) {
      expect(error).toBeInstanceOf(NonLiteralRouteExportError);

      const message = (error as Error).message;

      expect(message).toContain("list.page.tsx");
      expect(message).toContain("its value is a function call");
      expect(message).toContain("without running your application code");
      expect(message).toContain('export const route = "/list";');
    }
  });

  it("(c) composes the nearest layout's declared prefix with the declared route path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      // The prefix deliberately does NOT echo the directory name: a composition
      // that only ever agreed with the tree would be indistinguishable from the
      // filesystem derivation it replaced.
      "src/web/shop/products/layout.tsx": layoutDeclaring(
        'export const prefix = "/catalogue";',
      ),
      "src/web/shop/products/index.page.tsx": pageDeclaring('export const route = "/";'),
      "src/web/shop/products/detail.page.tsx": pageDeclaring(
        'export const route = "/detail";',
      ),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.map((page) => page.routePath).sort()).toEqual([
      "/catalogue",
      "/catalogue/detail",
    ]);
  });

  it("(d) collides on the DECLARED route name, however the files are named", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/alpha.page.tsx": pageDeclaring(
        'export const route = { path: "/alpha", name: "shop.catalogue" };',
      ),
      "src/web/shop/beta.page.tsx": pageDeclaring(
        'export const route = { path: "/beta", name: "shop.catalogue" };',
      ),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the duplicate declared route name");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicatePageRouteNameError);
      expect((error as Error).message).toContain("shop.catalogue");
    }
  });

  it("(e) derives a page path and dotted name when route is omitted", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/draft.page.tsx": pageDeclaring(""),
      "src/web/shop/live.page.tsx": pageDeclaring('export const route = "/live";'),
    });

    const draft = discoverPages({ appRoot }).find((page) => page.pageFile.endsWith("draft.page.tsx"));

    expect(draft?.routePath).toBe("/shop/draft");
    expect(draft?.routeName).toBe("shop.draft");
  });

  it("(f) reads through an `as const` wrapper rather than rejecting it", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/layout.tsx": layoutDeclaring('export const prefix = "/shop" as const;'),
      "src/web/shop/bare.page.tsx": pageDeclaring('export const route = "/bare" as const;'),
      "src/web/shop/object.page.tsx": pageDeclaring(
        'export const route = { path: "/object", name: "shop.thing" } as const;',
      ),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.map((page) => [page.routePath, page.routeName]).sort()).toEqual([
      ["/shop/bare", "shop.bare"],
      ["/shop/object", "shop.thing"],
    ]);
  });

  // BEHAVIOUR PINNED: an unsupported declared `path` must never reach `pages`
  // — regardless of whether an explicit `name` is ALSO declared alongside it.
  //
  // `routeName`'s own validation (`resolvePageRouteName` →
  // `canonicalizeRouteExport`) happens to also reject this same page, but that
  // is not what this test is guarding: a `route` with an explicit `name`
  // never NEEDS `resolvePageRouteName` to derive one, so a version of
  // discovery that reads `route.name` directly wherever it is present —
  // skipping `resolvePageRouteName` (and therefore skipping validation)
  // whenever the author was thoughtful enough to name the route — would
  // still pass every other test in this file while silently publishing the
  // unsupported path below. Only a path that is independently validated on
  // ITS OWN route (not merely as a side effect of validating something else
  // in the same object) closes that hole, so this test would still catch a
  // regression under such a refactor — reordering `routeName`/`routePath`,
  // hoisting the page object into a variable pushed before `routeName` runs,
  // or any other restructuring — because it fails whenever the path itself
  // was never checked, not because of what order things happened to run in.
  it("(g) refuses an unsupported declared path even when the route ALSO declares an explicit name", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/id.page.tsx": pageDeclaring(
        'export const route = { path: "/users/:id?", name: "userDetail" };',
      ),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable(
        "expected discovery to reject the unsupported path instead of publishing it",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(PageRoutePathNotSupportedError);
      expect((error as Error).message).toContain("users/id.page.tsx");
      expect((error as Error).message).toContain("/users/:id?");
    }
  });
});

describe("discoverPages — ancestor layout composition", () => {
  it("composes against the nearest ancestor layout's prefix when the page's own directory has none", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/main/layout.tsx": layoutDeclaring('export const prefix = "/admin";'),
      "src/web/main/settings/dashboard.page.tsx": routed("/settings"),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    // The layout lives one directory ABOVE the page. It is still the only
    // layout on the page's path, so its prefix composes the route — a page's
    // layout is decided by its whole ancestry, not by its own directory.
    expect(page.routePath).toBe("/admin/settings");
    expect(relative(appRoot, page.layouts)).toEqual(["src/web/main/layout.tsx"]);
  });
});

describe("discoverPages — property D: at most one RENDERING layout on a page's path", () => {
  it("refuses a page whose chain has more than one RENDERING layout, naming the page and both layouts", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": LAYOUT,
      "src/web/users/account/layout.tsx": LAYOUT,
      "src/web/users/account/settings.page.tsx": routed("/account/settings"),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the nested rendering layouts");
    } catch (error) {
      expect(error).toBeInstanceOf(NestedLayoutsNotSupportedError);

      const message = (error as Error).message;

      expect(message).toContain("src/web/users/account/settings.page.tsx");
      expect(message).toContain("src/web/users/layout.tsx");
      expect(message).toContain("src/web/users/account/layout.tsx");
      expect(message).toContain("at most one RENDERING layout");
      expect(message).toContain("not yet supported");
      expect(message).not.toContain("remove or consolidate");
    }
  });

  it("still discovers a page with exactly one layout on its path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/account/layout.tsx": LAYOUT,
      "src/web/users/account/settings.page.tsx": routed("/account/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.layouts)).toEqual(["src/web/users/account/layout.tsx"]);
  });

  it("still discovers a page with zero layouts on its path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/account/settings.page.tsx": routed("/account/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(page.layouts).toEqual([]);
    expect(page.middlewareLayouts).toEqual([]);
  });

  it("accepts a rendering layout beneath a NON-rendering one — a guard is not a wrapper", () => {
    // The exact shape `v5/app` ships: `/users` renders, `/account` only carries
    // a prefix. Two `layout.tsx` files, one wrapper — legal.
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        'export const prefix = "/account";',
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    // EVERY prefix on the path composes, outermost first, then the page's own
    // declared path — not just the selected layout's.
    expect(page.routePath).toBe("/users/account/settings");
    expect(relative(appRoot, page.layouts)).toEqual([
      "src/web/users/layout.tsx",
      "src/web/users/account/layout.tsx",
    ]);
  });

  it("composes prefixes outermost-first through three layouts, only one of which renders", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": nonRenderingLayout('export const prefix = "/users";'),
      "src/web/users/account/layout.tsx": layoutDeclaring('export const prefix = "/account";'),
      "src/web/users/account/settings/layout.tsx": nonRenderingLayout(
        'export const prefix = "/settings";',
      ),
      "src/web/users/account/settings/edit.page.tsx": routed("/edit"),
    });

    const [page] = discoverPages({ appRoot });

    expect(page.routePath).toBe("/users/account/settings/edit");
  });

  it("lets a non-rendering layout omit its prefix without contributing a segment", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        "export const somethingElse = 1;",
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    expect(discoverPages({ appRoot })[0].routePath).toBe("/users/settings");
  });

  it("names only the RENDERING layouts when it refuses, never the guard between them", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": LAYOUT,
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        'export const prefix = "/account";',
      ),
      "src/web/users/account/settings/layout.tsx": LAYOUT,
      "src/web/users/account/settings/edit.page.tsx": routed("/edit"),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the two rendering layouts");
    } catch (error) {
      expect(error).toBeInstanceOf(NestedLayoutsNotSupportedError);

      const message = (error as Error).message;

      expect(message).toContain("src/web/users/layout.tsx");
      expect(message).toContain("src/web/users/account/settings/layout.tsx");
      // The guard is not the user's problem here and must not be named as one.
      expect(message).not.toContain("src/web/users/account/layout.tsx");
    }
  });
});

describe("discoverPages — the middleware chain, and the temporary refusal that protects it", () => {
  const GATE = "export const middleware = [gate(permissions.account.view)];";

  it("reports every middleware-bearing layout on the path, outermost first", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring(`export const prefix = "/users";\n${GATE}`),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual(["src/web/users/layout.tsx"]);
    expect(page.routePath).toBe("/users/settings");
  });

  it("leaves the chain empty when no layout declares middleware", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        'export const prefix = "/account";',
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    expect(discoverPages({ appRoot })[0].middlewareLayouts).toEqual([]);
  });

  // These used to be refusals. Discovery raised
  // `UnwiredLayoutMiddlewareChainError` for a guard anywhere but the rendering
  // layout, because no consumer composed the chain and a page that quietly
  // served without its `gate()` is an unguarded route that looks like a working
  // one. Both installers now concatenate the whole chain into the pipeline's
  // single layout slot, outermost first, so the guard runs — and what discovery
  // owes its consumers is an honest REPORT of which layouts carry one, not a
  // refusal to build.
  it("reports a chain whose middleware sits on a layout that is not the selected one", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/web/users/account/layout.tsx",
    ]);
    expect(page.routePath).toBe("/users/account/settings");
  });

  it("reports middleware on a chain with no rendering layout at all", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/web/users/account/layout.tsx",
    ]);
  });

  it("reports EVERY layout that carries a guard, outermost first — the order they must run in", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring(`export const prefix = "/users";\n${GATE}`),
      "src/web/users/account/layout.tsx": nonRenderingLayout(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/web/users/layout.tsx",
      "src/web/users/account/layout.tsx",
    ]);
  });

  it("allows middleware on the SELECTED layout — that is the one dev already runs", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/account/layout.tsx": layoutDeclaring(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    expect(() => discoverPages({ appRoot })).not.toThrow();
  });

  it("treats a re-exporting layout as possibly carrying middleware rather than assuming it does not", () => {
    // `export * from "./guard"` can contribute a `middleware` binding that no
    // parse can see. Assuming it does not is precisely the silent unguarding
    // this rule exists to prevent, so the conservative read is that it does —
    // which now puts the layout in the chain the installers compose rather than
    // failing the build.
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/users/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/web/users/account/layout.tsx": nonRenderingLayout('export * from "./guard";'),
      "src/web/users/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/web/users/account/layout.tsx",
    ]);
  });
});

/**
 * The not-found page is the one page with no URL, and discovery has to agree
 * with both installers about that — or the build emits an artefact the server
 * refuses (or worse, one it accepts and serves differently).
 */
describe("discoverPages — 404.page.tsx", () => {
  it("reports it without a `route` export under the reserved not-found identity", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/home.page.tsx": pageDeclaring('export const route = "/";'),
      "src/web/404.page.tsx": pageDeclaring(""),
    });

    const pages = discoverPages({ appRoot });

    expect(pages).toHaveLength(2);

    const notFound = pages.find((page) => page.pageFile.endsWith("404.page.tsx"));

    // The reserved identity both installers register it under, so the client
    // registry and the SSR'd document agree about which entry this is.
    expect(notFound?.routeName).toBe("warlock.not-found");
    // The catch-all the client matcher understands as a terminal token, sorted
    // last by specificity — never in preference to a real page.
    expect(notFound?.routePath).toBe("*");
  });

  it("derives every other route-less page in the same tree", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/404.page.tsx": pageDeclaring(""),
      "src/web/draft.page.tsx": pageDeclaring(""),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.find((page) => page.pageFile.endsWith("draft.page.tsx"))?.routePath).toBe("/draft");
  });

  it("refuses a `route` export on it — the opposite error, for the opposite reason", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/404.page.tsx": pageDeclaring('export const route = "/404";'),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject a not-found page with a route export");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundPageDeclaresRouteError);
      expect((error as Error).message).toContain("404.page.tsx");
    }
  });

  it("refuses two of them, because the reserved route name can only identify one", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/404.page.tsx": pageDeclaring(""),
      "src/web/shop/404.page.tsx": pageDeclaring(""),
    });

    expect(() => discoverPages({ appRoot })).toThrowError(DuplicatePageRouteNameError);
  });
});

/**
 * `error.page.tsx` is the one application error boundary — a different
 * discovery KIND from a routable page (deliberately no route identity), and
 * these fixtures use {@link discoverPagesRaw} directly rather than the
 * routable-filtering `discoverPages` helper every other block in this file
 * shares.
 */
describe("discoverPages — error.page.tsx", () => {
  it("reports it under the reserved error identity, distinct from every routable page", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/home.page.tsx": routed("/home"),
      "src/web/error.page.tsx": pageDeclaring(""),
    });

    const pages = discoverPagesRaw({ appRoot });

    expect(pages).toHaveLength(2);

    const errorPage = pages.find((page) => page.type === "error");

    expect(errorPage).toBeDefined();
    expect(relative(appRoot, [errorPage!.pageFile])).toEqual(["src/web/error.page.tsx"]);
    expect(relative(appRoot, [errorPage!.appFile as string])).toEqual(["src/web/root.tsx"]);
    // No route identity at all — the type this block asserts is the union
    // discriminant `discoverPages` filters callers away from having to see.
    expect(errorPage).not.toHaveProperty("routeName");
    expect(errorPage).not.toHaveProperty("routePath");

    // The routable half of the same result is unaffected: `home` is still the
    // only page `isDiscoveredRoutablePage` returns.
    expect(discoverPages({ appRoot }).map((page) => page.routeName)).toEqual(["home"]);
  });

  it("refuses a `route` export on it — an error boundary is not a browsable page", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/error.page.tsx": routed("/error"),
    });

    try {
      discoverPagesRaw({ appRoot });
      expect.unreachable("expected discovery to reject an error page with a route export");
    } catch (error) {
      expect(error).toBeInstanceOf(ErrorPageDeclaresRouteError);
      expect((error as Error).message).toContain("error.page.tsx");
      expect((error as Error).message).toContain("remove the route export");
    }
  });

  it("refuses two of them, naming both files — an application owns exactly one", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/error.page.tsx": pageDeclaring(""),
      "src/web/shop/error.page.tsx": pageDeclaring(""),
    });

    try {
      discoverPagesRaw({ appRoot });
      expect.unreachable("expected discovery to reject a second error page");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateErrorPageError);

      const message = (error as Error).message;

      expect(message).toContain("src/web/error.page.tsx");
      expect(message).toContain("src/web/shop/error.page.tsx");
      expect(message).toContain("exactly one");
    }
  });
});

/**
 * THE DEFECT THIS BLOCK EXISTS FOR, in the words of the report that found it:
 *
 * ```ts
 * export const metadata = { tittle: x }
 * ```
 *
 * `tittle` is not a joke — it is the specification. That line compiles, the page
 * is served with no `<title>`, and nothing anywhere says a word. An annotated
 * export is refused by TypeScript (`metadata.spec.ts` proves that, executed by
 * `yarn typecheck`); NOBODY WRITES THE ANNOTATION, so the contract is checked
 * here too, where every page already passes through.
 */
describe("discoverPages — the `metadata` contract", () => {
  /** A routed page whose `metadata` export is `declaration`, verbatim. */
  function pageWithMetadata(declaration: string): string {
    return pageDeclaring(`export const route = "/list";\n${declaration}`);
  }

  function discoverWith(metadata: string) {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/products.page.tsx": pageWithMetadata(metadata),
    });

    return () => discoverPages({ appRoot });
  }

  it("REFUSES an unannotated typo — the one the compiler cannot see", () => {
    // No `: PageMetadata` anywhere. TypeScript infers `{ tittle: string }` and
    // is satisfied. This is the acceptance criterion: a fix that only fires
    // when someone already wrote the type is a fix that does not fire.
    const discover = discoverWith('export const metadata = { tittle: "x" };');

    expect(discover).toThrow(UnknownMetadataKeyError);
    // The FILE and the KEY, because a build error that says only "unknown key"
    // sends the developer looking through every page they have.
    expect(discover).toThrow(/src\/web\/shop\/products\.page\.tsx/);
    expect(discover).toThrow(/tittle/);
  });

  it("names the line and suggests the key that was meant", () => {
    const discover = discoverWith('export const metadata = { tittle: "x" };');

    try {
      discover();
      expect.unreachable("discovery accepted an unknown metadata key");
    } catch (error) {
      const failure = error as UnknownMetadataKeyError;

      expect(failure.unknownKeys).toEqual([
        { container: "metadata", key: "tittle", line: 2, suggestion: "title" },
      ]);
      expect(failure.message).toContain("Did you mean `title`?");
    }
  });

  it("accepts every key a renderer actually reads, and no page pays for the check", () => {
    // The full surface of `MetadataOutput`, which is the full surface of
    // `components/head.ts` — if this ever throws, the type and the key list
    // have drifted from the tags.
    const discover = discoverWith(`export const metadata = {
      title: "Products",
      description: "Everything in stock",
      keywords: ["shop", "products"],
      canonical: "https://example.com/products",
      robots: "index,follow",
      openGraph: { title: "Products", description: "d", image: "i", url: "u", type: "website" },
      twitter: { card: "summary", title: "Products", description: "d", image: "i" },
    };`);

    expect(discover).not.toThrow();
  });

  it("checks INSIDE openGraph and twitter — same silence, one level down", () => {
    const discover = discoverWith(
      'export const metadata = { title: "x", openGraph: { titel: "x" } };',
    );

    expect(discover).toThrow(/`metadata\.openGraph\.titel`/);
    expect(discover).toThrow(/Did you mean `title`\?/);
  });

  it("checks the FUNCTION form's concise body — how every reference-app page writes it", () => {
    const discover = discoverWith(
      'export const metadata = ({ data }) => ({ title: data.name, descriptoin: "x" });',
    );

    expect(discover).toThrow(/`metadata\.descriptoin`/);
    expect(discover).toThrow(/Did you mean `description`\?/);
  });

  it("checks a function form's `return`, wherever in the body it sits", () => {
    const discover = discoverWith(`export const metadata = ({ data }) => {
      if (data.missing) {
        return { robtos: "noindex" };
      }

      return { title: data.name };
    };`);

    expect(discover).toThrow(/`metadata\.robtos`/);
    expect(discover).toThrow(/Did you mean `robots`\?/);
  });

  it("does not mistake a nested callback's return for the metadata", () => {
    const discover = discoverWith(`export const metadata = ({ data }) => {
      const rows = data.items.map(item => ({ tittle: item.name }));

      return { title: rows.length + " items" };
    };`);

    expect(discover).not.toThrow();
  });

  it("reports EVERY unknown key at once, not the first one per build", () => {
    const discover = discoverWith(
      'export const metadata = { tittle: "x", descripton: "y", robots: "noindex" };',
    );

    try {
      discover();
      expect.unreachable("discovery accepted unknown metadata keys");
    } catch (error) {
      expect((error as UnknownMetadataKeyError).unknownKeys.map(({ key }) => key)).toEqual([
        "tittle",
        "descripton",
      ]);
    }
  });

  it("still refuses a key it cannot suggest a replacement for", () => {
    const discover = discoverWith('export const metadata = { openGraphImage: "x" };');

    expect(discover).toThrow(/`metadata\.openGraphImage` — no such key\./);
    expect(discover).not.toThrow(/Did you mean/);
  });

  it("a spread adds keys but excuses none written beside it", () => {
    const discover = discoverWith(
      'export const metadata = { ...base, tittle: "x" };',
    );

    expect(discover).toThrow(/`metadata\.tittle`/);
  });

  it("says nothing about metadata it genuinely cannot read — computed keys and values elsewhere", () => {
    // Refusing what a parse cannot see would fail builds that are fine. The
    // type annotation is the second net in exactly these narrow places.
    expect(discoverWith("export const metadata = buildMetadata();")).not.toThrow();
    expect(discoverWith("export const metadata = shared;")).not.toThrow();
    expect(discoverWith('export const metadata = { [key]: "x" };')).not.toThrow();
  });

  it("leaves a page with no metadata export alone — it is an optional export", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/products.page.tsx": routed("/list"),
    });

    expect(() => discoverPages({ appRoot })).not.toThrow();
  });

  it("checks the ANNOTATED form too — the two nets catch the same key", () => {
    const discover = discoverWith(
      'export const metadata: PageMetadata = { tittle: "x" } as PageMetadata;',
    );

    expect(discover).toThrow(/`metadata\.tittle`/);
  });

  it("still validates metadata when the route is derived", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/shop/products.page.tsx": pageDeclaring(
        'export const metadata = { tittle: "x" };',
      ),
    });

    expect(() => discoverPages({ appRoot })).toThrow(/`metadata\.tittle`/);
  });
});

describe("discoverPages — filesystem route derivation", () => {
  it("derives index, nested, group and dynamic paths", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/index.page.tsx": pageDeclaring(""),
      "src/web/home.page.tsx": pageDeclaring(""),
      "src/web/welcome/index.page.tsx": pageDeclaring(""),
      "src/web/welcome/home.page.tsx": pageDeclaring(""),
      "src/web/(marketing)/pricing.page.tsx": pageDeclaring(""),
      "src/web/products/[id].page.tsx": pageDeclaring(""),
    });

    const routes = Object.fromEntries(
      discoverPages({ appRoot }).map((page) => [
        path.relative(path.join(appRoot, "src/web"), page.pageFile),
        page.routePath,
      ]),
    );

    expect(routes).toMatchObject({
      "index.page.tsx": "/",
      "home.page.tsx": "/home",
      [path.join("welcome", "index.page.tsx")]: "/welcome",
      [path.join("welcome", "home.page.tsx")]: "/welcome/home",
      [path.join("(marketing)", "pricing.page.tsx")]: "/pricing",
      [path.join("products", "[id].page.tsx")]: "/products/:id",
    });
  });

  it("lets each layout prefix replace its own directory segment", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/welcome/layout.tsx": nonRenderingLayout('export const prefix = "/welcome";'),
      "src/web/welcome/home.page.tsx": pageDeclaring(""),
      "src/web/admin/layout.tsx": nonRenderingLayout('export const prefix = "/dashboard";'),
      "src/web/admin/index.page.tsx": pageDeclaring(""),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.find((page) => page.pageFile.endsWith("home.page.tsx"))?.routePath).toBe(
      "/welcome/home",
    );
    expect(pages.find((page) => page.pageFile.endsWith("index.page.tsx"))?.routePath).toBe(
      "/dashboard",
    );
  });

  it.each([
    [
      "derived and declared",
      {
        "src/web/account.page.tsx": pageDeclaring(""),
        "src/web/legacy.page.tsx": routed("/account"),
      },
    ],
    [
      "two groups",
      {
        "src/web/(a)/settings.page.tsx": pageDeclaring(""),
        "src/web/(b)/settings.page.tsx": pageDeclaring(""),
      },
    ],
  ])("refuses a %s path collision and names both files", (_kind, tree) => {
    const appRoot = makeAppTree({ "src/web/root.tsx": APP, ...tree });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected a duplicate route path");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicatePageRoutePathError);
      expect((error as Error).message).toContain(".page.tsx");
    }
  });
});
