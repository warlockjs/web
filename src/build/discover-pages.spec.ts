import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
import {
  discoverPages,
  DuplicatePageRouteNameError,
  MissingRouteExportError,
  UnknownMetadataKeyError,
} from "./discover-pages";
import { NotFoundPageDeclaresRouteError } from "../server/not-found-page";
import { NonLiteralRouteExportError } from "./read-route-exports";

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
 * Every fixture says which route it means, because that is the only thing
 * discovery reads: a page that declares nothing is a page with no route at all,
 * not a page named after its directory.
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
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": routed("/account/settings"),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    expect(relative(appRoot, [page.pageFile])).toEqual([
      "src/app/users/web/account/settings.page.tsx",
    ]);
    expect(relative(appRoot, page.layouts)).toEqual(["src/app/users/web/account/layout.tsx"]);
    expect(relative(appRoot, [page.appFile as string])).toEqual(["src/web/root.tsx"]);
    expect(page.routePath).toBe("/account/settings");
    expect(page.routeName).toBe("users.account.settings");
  });

  it("collects pages from BOTH web roots, exactly the set the barrel emitted", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/layout.tsx": LAYOUT,
      "src/web/dashboard.page.tsx": routed("/dashboard"),
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": routed("/account/settings"),
    });

    const pages = discoverPages({ appRoot });

    expect(relative(appRoot, pages.map((page) => page.pageFile)).sort()).toEqual([
      "src/app/users/web/account/settings.page.tsx",
      "src/web/dashboard.page.tsx",
    ]);

    const dashboard = pages.find((page) => page.routeName === "dashboard");

    expect(relative(appRoot, dashboard?.layouts ?? [])).toEqual(["src/web/layout.tsx"]);
  });

  it("leaves `appFile` unset when there is no root.tsx — that verdict belongs to the consumer", () => {
    const appRoot = makeAppTree({ "src/app/main/web/home.page.tsx": routed("/home") });

    const [page] = discoverPages({ appRoot });

    expect(page.appFile).toBeUndefined();
    expect(page.routeName).toBe("main.home");
  });

  it("derives an undeclared name from the DECLARED path, prefixed by the module", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/shop/web/index.page.tsx": routed("/"),
      "src/app/shop/web/items/index.page.tsx": routed("/items"),
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

describe("discoverPages — property A: a defined total order", () => {
  it("sorts lexicographically by SOURCE FILE PATH, never by route path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/shop/web/index.page.tsx": routed("/z-last"),
      "src/app/shop/web/items/detail.page.tsx": routed("/a-first"),
      "src/web/about.page.tsx": routed("/m-middle"),
    });

    const pages = discoverPages({ appRoot });

    // Route-path order would be /a-first, /m-middle, /z-last. The file decides:
    // a page's route is one line an author can rewrite, and reordering the whole
    // artefact on that edit is churn nobody asked for.
    expect(relative(appRoot, pages.map((page) => page.pageFile))).toEqual([
      "src/app/shop/web/index.page.tsx",
      "src/app/shop/web/items/detail.page.tsx",
      "src/web/about.page.tsx",
    ]);
    expect(pages.map((page) => page.routePath)).toEqual(["/z-last", "/a-first", "/m-middle"]);
  });

  it("still orders two pages that declare the SAME route path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/zebra.page.tsx": routed("/zebra"),
      "src/web/alpha.page.tsx": routed("/alpha"),
      // One route path from both roots — only the file path separates them.
      "src/web/list.page.tsx": routed("/list"),
      "src/app/users/web/list.page.tsx": routed("/list"),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.map((page) => [page.routePath, page.routeName])).toEqual([
      ["/list", "users.list"],
      ["/alpha", "alpha"],
      ["/list", "list"],
      ["/zebra", "zebra"],
    ]);
  });

  it("gives a parameter segment no rank of its own — `[` simply sorts before `p`", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/[id].page.tsx": routed("/[id]"),
      "src/app/users/web/profile.page.tsx": routed("/profile"),
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
      "src/app/shop/web/index.page.tsx": routed("/"),
      "src/app/shop/web/items/detail.page.tsx": routed("/items/detail"),
      "src/app/shop/web/items/summary.page.tsx": routed("/items/summary"),
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
      "src/web/users/list.page.tsx": routed("/users/list"),
      "src/app/users/web/list.page.tsx": routed("/list"),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the duplicate route name");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicatePageRouteNameError);

      const message = (error as Error).message;

      expect(message).toContain("users.list");
      expect(message).toContain("src/web/users/list.page.tsx");
      expect(message).toContain("src/app/users/web/list.page.tsx");
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
      "src/app/users/web/list.page.tsx": routed("/list"),
    });

    expect(discoverPages({ appRoot }).map((page) => page.routeName)).toEqual([
      "users.list",
      "list",
    ]);
  });
});

describe("discoverPages — property C: the canonical route is the DECLARED one", () => {
  it("(a) takes the declared route path over the filesystem-derived one", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/list.page.tsx": pageDeclaring(
        'export const route = "/people/directory";',
      ),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    expect(page.routePath).toBe("/people/directory");
    expect(page.routeName).toBe("users.people.directory");
  });

  it("(b) refuses a computed route export, naming the file, before returning anything", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/list.page.tsx": pageDeclaring(
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
      "src/app/shop/web/products/layout.tsx": layoutDeclaring(
        'export const prefix = "/catalogue";',
      ),
      "src/app/shop/web/products/index.page.tsx": pageDeclaring('export const route = "/";'),
      "src/app/shop/web/products/detail.page.tsx": pageDeclaring(
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
      "src/app/shop/web/alpha.page.tsx": pageDeclaring(
        'export const route = { path: "/alpha", name: "shop.catalogue" };',
      ),
      "src/app/shop/web/beta.page.tsx": pageDeclaring(
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

  it("(e) refuses a page with no route export, naming the file, before returning anything", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/shop/web/draft.page.tsx": pageDeclaring(""),
      "src/app/shop/web/live.page.tsx": pageDeclaring('export const route = "/live";'),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the page with no route export");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingRouteExportError);

      const message = (error as Error).message;

      expect(message).toContain("draft.page.tsx");
      expect(message).toContain('export const route = "/list";');
    }
  });

  it("(f) reads through an `as const` wrapper rather than rejecting it", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/shop/web/layout.tsx": layoutDeclaring('export const prefix = "/shop" as const;'),
      "src/app/shop/web/bare.page.tsx": pageDeclaring('export const route = "/bare" as const;'),
      "src/app/shop/web/object.page.tsx": pageDeclaring(
        'export const route = { path: "/object", name: "shop.thing" } as const;',
      ),
    });

    const pages = discoverPages({ appRoot });

    expect(pages.map((page) => [page.routePath, page.routeName]).sort()).toEqual([
      ["/shop/bare", "shop.bare"],
      ["/shop/object", "shop.thing"],
    ]);
  });
});

describe("discoverPages — ancestor layout composition", () => {
  it("composes against the nearest ancestor layout's prefix when the page's own directory has none", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/layout.tsx": layoutDeclaring('export const prefix = "/admin";'),
      "src/app/main/web/settings/dashboard.page.tsx": routed("/settings"),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    // The layout lives one directory ABOVE the page. It is still the only
    // layout on the page's path, so its prefix composes the route — a page's
    // layout is decided by its whole ancestry, not by its own directory.
    expect(page.routePath).toBe("/admin/settings");
    expect(relative(appRoot, page.layouts)).toEqual(["src/app/main/web/layout.tsx"]);
  });
});

describe("discoverPages — property D: at most one RENDERING layout on a page's path", () => {
  it("refuses a page whose chain has more than one RENDERING layout, naming the page and both layouts", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": LAYOUT,
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": routed("/account/settings"),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the nested rendering layouts");
    } catch (error) {
      expect(error).toBeInstanceOf(NestedLayoutsNotSupportedError);

      const message = (error as Error).message;

      expect(message).toContain("src/app/users/web/account/settings.page.tsx");
      expect(message).toContain("src/app/users/web/layout.tsx");
      expect(message).toContain("src/app/users/web/account/layout.tsx");
      expect(message).toContain("at most one RENDERING layout");
      expect(message).toContain("not yet supported");
      expect(message).not.toContain("remove or consolidate");
    }
  });

  it("still discovers a page with exactly one layout on its path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": routed("/account/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.layouts)).toEqual(["src/app/users/web/account/layout.tsx"]);
  });

  it("still discovers a page with zero layouts on its path", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/account/settings.page.tsx": routed("/account/settings"),
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
      "src/app/users/web/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        'export const prefix = "/account";',
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    const [page, ...rest] = discoverPages({ appRoot });

    expect(rest).toEqual([]);
    // EVERY prefix on the path composes, outermost first, then the page's own
    // declared path — not just the selected layout's.
    expect(page.routePath).toBe("/users/account/settings");
    expect(relative(appRoot, page.layouts)).toEqual([
      "src/app/users/web/layout.tsx",
      "src/app/users/web/account/layout.tsx",
    ]);
  });

  it("composes prefixes outermost-first through three layouts, only one of which renders", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": nonRenderingLayout('export const prefix = "/users";'),
      "src/app/users/web/account/layout.tsx": layoutDeclaring('export const prefix = "/account";'),
      "src/app/users/web/account/settings/layout.tsx": nonRenderingLayout(
        'export const prefix = "/settings";',
      ),
      "src/app/users/web/account/settings/edit.page.tsx": routed("/edit"),
    });

    const [page] = discoverPages({ appRoot });

    expect(page.routePath).toBe("/users/account/settings/edit");
  });

  it("lets a non-rendering layout omit its prefix without contributing a segment", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        "export const somethingElse = 1;",
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    expect(discoverPages({ appRoot })[0].routePath).toBe("/users/settings");
  });

  it("names only the RENDERING layouts when it refuses, never the guard between them", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": LAYOUT,
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        'export const prefix = "/account";',
      ),
      "src/app/users/web/account/settings/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings/edit.page.tsx": routed("/edit"),
    });

    try {
      discoverPages({ appRoot });
      expect.unreachable("expected discovery to reject the two rendering layouts");
    } catch (error) {
      expect(error).toBeInstanceOf(NestedLayoutsNotSupportedError);

      const message = (error as Error).message;

      expect(message).toContain("src/app/users/web/layout.tsx");
      expect(message).toContain("src/app/users/web/account/settings/layout.tsx");
      // The guard is not the user's problem here and must not be named as one.
      expect(message).not.toContain("src/app/users/web/account/layout.tsx");
    }
  });
});

describe("discoverPages — the middleware chain, and the temporary refusal that protects it", () => {
  const GATE = "export const middleware = [gate(permissions.account.view)];";

  it("reports every middleware-bearing layout on the path, outermost first", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": layoutDeclaring(`export const prefix = "/users";\n${GATE}`),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual(["src/app/users/web/layout.tsx"]);
    expect(page.routePath).toBe("/users/settings");
  });

  it("leaves the chain empty when no layout declares middleware", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        'export const prefix = "/account";',
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
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
      "src/app/users/web/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/app/users/web/account/layout.tsx",
    ]);
    expect(page.routePath).toBe("/users/account/settings");
  });

  it("reports middleware on a chain with no rendering layout at all", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/app/users/web/account/layout.tsx",
    ]);
  });

  it("reports EVERY layout that carries a guard, outermost first — the order they must run in", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": layoutDeclaring(`export const prefix = "/users";\n${GATE}`),
      "src/app/users/web/account/layout.tsx": nonRenderingLayout(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/app/users/web/layout.tsx",
      "src/app/users/web/account/layout.tsx",
    ]);
  });

  it("allows middleware on the SELECTED layout — that is the one dev already runs", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/account/layout.tsx": layoutDeclaring(
        `export const prefix = "/account";\n${GATE}`,
      ),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
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
      "src/app/users/web/layout.tsx": layoutDeclaring('export const prefix = "/users";'),
      "src/app/users/web/account/layout.tsx": nonRenderingLayout('export * from "./guard";'),
      "src/app/users/web/account/settings.page.tsx": routed("/settings"),
    });

    const [page] = discoverPages({ appRoot });

    expect(relative(appRoot, page.middlewareLayouts)).toEqual([
      "src/app/users/web/account/layout.tsx",
    ]);
  });
});

/**
 * The not-found page is the one page with no URL, and discovery has to agree
 * with both installers about that — or the build emits an artefact the server
 * refuses (or worse, one it accepts and serves differently).
 */
describe("discoverPages — 404.page.tsx", () => {
  it("reports it without a `route` export, where any other page would be refused", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/home.page.tsx": pageDeclaring('export const route = "/";'),
      "src/app/main/web/404.page.tsx": pageDeclaring(""),
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

  it("still refuses every OTHER route-less page in the same tree", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/404.page.tsx": pageDeclaring(""),
      "src/app/main/web/draft.page.tsx": pageDeclaring(""),
    });

    expect(() => discoverPages({ appRoot })).toThrowError(MissingRouteExportError);
  });

  it("refuses a `route` export on it — the opposite error, for the opposite reason", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/404.page.tsx": pageDeclaring('export const route = "/404";'),
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
      "src/app/main/web/404.page.tsx": pageDeclaring(""),
      "src/app/shop/web/404.page.tsx": pageDeclaring(""),
    });

    expect(() => discoverPages({ appRoot })).toThrowError(DuplicatePageRouteNameError);
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
      "src/app/shop/web/products.page.tsx": pageWithMetadata(metadata),
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
    expect(discover).toThrow(/src\/app\/shop\/web\/products\.page\.tsx/);
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
      "src/app/shop/web/products.page.tsx": routed("/list"),
    });

    expect(() => discoverPages({ appRoot })).not.toThrow();
  });

  it("checks the ANNOTATED form too — the two nets catch the same key", () => {
    const discover = discoverWith(
      'export const metadata: PageMetadata = { tittle: "x" } as PageMetadata;',
    );

    expect(discover).toThrow(/`metadata\.tittle`/);
  });

  it("refuses the route-less page FIRST — the bigger defect names its own line", () => {
    // Order is a decision, not an accident: a page nothing can reach is a
    // larger problem than a page reached with a missing tag.
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/shop/web/products.page.tsx": pageDeclaring(
        'export const metadata = { tittle: "x" };',
      ),
    });

    expect(() => discoverPages({ appRoot })).toThrow(MissingRouteExportError);
  });
});
