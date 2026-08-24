import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverPages, toPosix } from "../build/discover-pages";
import { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
import { href, resetRouteTable, routeTablePublisher } from "../routing/route-table";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";

type RegisteredRoute = {
  path: string;
  handler: PageRouteHandler;
  options: { name?: string; isPage?: boolean };
};

/**
 * A router stand-in that records what was registered. Registration is the whole
 * observable output of this module, so the double only has to remember it.
 */
function recordingRouter() {
  const registered: RegisteredRoute[] = [];

  const router = {
    get(path: string, handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      registered.push({ path, handler, options });
    },
  } as unknown as InstallPageRoutesFromManifestOptions["router"];

  return { router, registered };
}

/**
 * A handler-factory stand-in that records the options it was built with, so the
 * ids and collaborators handed to each handler can be asserted without running
 * a render.
 */
function recordingHandlerFactory() {
  const built: PageRouteHandlerOptions[] = [];

  const createHandler = (options: PageRouteHandlerOptions): PageRouteHandler => {
    built.push(options);

    return async () => undefined;
  };

  return { createHandler, built };
}

const applyBufferedCookie = vi.fn() as InstallPageRoutesFromManifestOptions["applyBufferedCookie"];

const temporaryDirectories: string[] = [];

/** Materialises a fixture app tree: `{ "src/web/dashboard.page.tsx": "" }` under a temp root. */
function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-install-from-manifest-"));
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

const appModule = { default: () => null };

function manifestOf(pages: PageManifestPageEntry[]): PageManifest {
  return { app: { module: appModule, sourceFile: "src/web/root.tsx" }, pages };
}

const homeLayout = {
  module: { default: () => null, prefix: "/" },
  sourceFile: "src/app/main/web/layout.tsx",
};

const homePage: PageManifestPageEntry = {
  module: { default: () => null, route: "/" },
  sourceFile: "src/app/main/web/home.page.tsx",
  layouts: [homeLayout],
};

const productsPage: PageManifestPageEntry = {
  module: { default: () => null, route: "/" },
  sourceFile: "src/app/products/web/products.page.tsx",
  layouts: [
    {
      module: { default: () => null, prefix: "/products" },
      sourceFile: "src/app/products/web/layout.tsx",
    },
  ],
};

function install(
  manifest: PageManifest,
  overrides: Partial<InstallPageRoutesFromManifestOptions> = {},
) {
  const { router, registered } = recordingRouter();
  const { createHandler, built } = recordingHandlerFactory();

  const run = () =>
    installPageRoutesFromManifest({
      router,
      manifest,
      applyBufferedCookie,
      createHandler,
      ...overrides,
    });

  return { run, registered, built };
}

describe("production page route installation", () => {
  it("registers one page route per manifest entry, with the page route options a page needs", () => {
    const { run, registered } = install(manifestOf([homePage]));

    const installed = run();

    expect(registered).toHaveLength(1);
    expect(registered[0].path).toBe("/");
    expect(registered[0].options).toEqual({ name: "main", isPage: true });
    expect(installed).toEqual([
      {
        path: "/",
        name: "main",
        file: "src/app/main/web/home.page.tsx",
        layoutFile: "src/app/main/web/layout.tsx",
      },
    ]);
  });

  it("composes the layout prefix with the page's declared route path", () => {
    const { run, registered } = install(manifestOf([homePage, productsPage]));

    run();

    expect(registered.map((route) => route.path)).toEqual(["/", "/products"]);
  });

  it("composes against the root prefix when a page has no layout", () => {
    const contactPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/contact-us" },
      sourceFile: "src/app/main/web/contact-us.page.tsx",
      layouts: [],
    };

    const { run, registered, built } = install(manifestOf([contactPage]));

    run();

    expect(registered[0].path).toBe("/contact-us");
    expect(built[0].layoutFile).toBeUndefined();
  });

  it("composes against the root prefix when the layout exports no prefix", () => {
    const page: PageManifestPageEntry = {
      module: { default: () => null, route: "/about" },
      sourceFile: "src/app/main/web/about.page.tsx",
      layouts: [{ module: { default: () => null }, sourceFile: "src/app/main/web/layout.tsx" }],
    };

    const { run, registered } = install(manifestOf([page]));

    run();

    expect(registered[0].path).toBe("/about");
  });

  it("takes the route path and name off an object route export", () => {
    const page: PageManifestPageEntry = {
      module: { default: () => null, route: { path: "/blog", name: "blog.listing" } },
      sourceFile: "src/app/main/web/blog.page.tsx",
      layouts: [],
    };

    const { run, registered } = install(manifestOf([page]));

    run();

    expect(registered[0].path).toBe("/blog");
    expect(registered[0].options.name).toBe("blog.listing");
  });

  it("derives the route name from the source file when the route export declares none", () => {
    const page: PageManifestPageEntry = {
      module: { default: () => null, route: "/blog/latest" },
      sourceFile: "src/app/main/web/blog/latest.page.tsx",
      layouts: [],
    };

    const { run, registered } = install(manifestOf([page]));

    run();

    expect(registered[0].options.name).toBe("main.blog.latest");
  });

  it("skips a page module that exports no route, exactly as development discovery does", () => {
    const page: PageManifestPageEntry = {
      module: { default: () => null },
      sourceFile: "src/app/main/web/draft.page.tsx",
      layouts: [],
    };

    const { run, registered } = install(manifestOf([page]));

    expect(run()).toEqual([]);
    expect(registered).toHaveLength(0);
  });

  it("hands each handler the manifest's own source file strings, byte for byte", () => {
    const nestedPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/deep" },
      sourceFile: "src/app/main/web/nested/deep.page.tsx",
      layouts: [homeLayout],
    };

    const { run, built } = install(manifestOf([nestedPage]));

    run();

    expect(built[0].pageFile).toBe("src/app/main/web/nested/deep.page.tsx");
    expect(built[0].layoutFile).toBe("src/app/main/web/layout.tsx");
    expect(built[0].appFile).toBe("src/web/root.tsx");
  });

  it("hands each handler ids the manifest's own module loader can resolve", async () => {
    const { run, built } = install(manifestOf([homePage]));

    run();

    const { loadModule, pageFile, layoutFile, appFile } = built[0];

    await expect(loadModule(pageFile)).resolves.toBe(homePage.module);
    await expect(loadModule(layoutFile as string)).resolves.toBe(homeLayout.module);
    await expect(loadModule(appFile)).resolves.toBe(appModule);
  });

  it("forwards the hydration client module url and the cookie applier to each handler", () => {
    const { run, built } = install(manifestOf([homePage]), {
      hydrationClientModuleUrl: "/assets/hydrate.js",
    });

    run();

    expect(built[0].hydrationClientModuleUrl).toBe("/assets/hydrate.js");
    expect(built[0].applyBufferedCookie).toBe(applyBufferedCookie);
  });

  it("refuses a page whose layout chain is nested, naming the page and its layouts", () => {
    const nestedLayoutsPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/dashboard" },
      sourceFile: "src/app/main/web/dashboard.page.tsx",
      layouts: [
        { module: { default: () => null, prefix: "/" }, sourceFile: "src/app/main/web/layout.tsx" },
        {
          module: { default: () => null, prefix: "/dashboard" },
          sourceFile: "src/app/main/web/dashboard/layout.tsx",
        },
      ],
    };

    const { run, registered } = install(manifestOf([nestedLayoutsPage]));

    // The refusal is the SAME error every other door raises for a nested
    // chain — one class, one message shape, whichever side of the build the
    // fault surfaces on.
    expect(run).toThrowError(NestedLayoutsNotSupportedError);
    expect(run).toThrowError(/more than one layout on its path/);
    expect(run).toThrowError(/src\/app\/main\/web\/dashboard\.page\.tsx/);
    expect(run).toThrowError(/src\/app\/main\/web\/layout\.tsx/);
    expect(run).toThrowError(/src\/app\/main\/web\/dashboard\/layout\.tsx/);
    expect(registered).toHaveLength(0);
  });

  it("refuses a manifest that carries pages but no application root, naming what is missing", () => {
    const { run, registered, built } = install({ pages: [homePage] });

    expect(run).toThrowError(/no application root/);
    expect(run).toThrowError(/app/);
    expect(registered).toHaveLength(0);
    expect(built).toHaveLength(0);
  });

  it("refuses two pages that compose to the same route path, naming both", () => {
    const duplicate: PageManifestPageEntry = {
      module: { default: () => null, route: { path: "/", name: "main.home-again" } },
      sourceFile: "src/app/main/web/index.page.tsx",
      layouts: [homeLayout],
    };

    const { run } = install(manifestOf([homePage, duplicate]));

    expect(run).toThrowError(/src\/app\/main\/web\/home\.page\.tsx/);
    expect(run).toThrowError(/src\/app\/main\/web\/index\.page\.tsx/);
  });

  it("registers nothing and throws nothing for a build that discovered no pages", () => {
    const { run, registered, built } = install({ pages: [] });

    expect(run()).toEqual([]);
    expect(registered).toHaveLength(0);
    expect(built).toHaveLength(0);
  });
});

/**
 * The layout level reaches the render pipeline through exactly two of a
 * handler's options — `layoutFile` (the id) and `loadModule` (what answers that
 * id) — so reading the pair back is how a spec observes the composed middleware
 * chain without standing a render up behind it. Same seam
 * `install-page-routes.spec.ts` observes dev through.
 */
async function layoutMiddlewareOf(handlerOptions: PageRouteHandlerOptions) {
  if (handlerOptions.layoutFile === undefined) return [];

  const layoutModule = (await handlerOptions.loadModule(handlerOptions.layoutFile)) as {
    middleware?: readonly ((context: unknown) => unknown)[];
  };

  return [...(layoutModule.middleware ?? [])];
}

/**
 * Runs the layout level's middleware the way stage 3 does — the array, in array
 * order — so the assertions below are about observed call ORDER, not about
 * membership of a list.
 */
async function runLayoutMiddleware(handlerOptions: PageRouteHandlerOptions) {
  for (const middleware of await layoutMiddlewareOf(handlerOptions)) {
    await middleware({});
  }
}

describe("installPageRoutesFromManifest — the layout middleware chain", () => {
  it("runs EVERY layout's middleware, outermost first — the outer layout renders, the inner one only guards", async () => {
    const calls: string[] = [];

    const guardedPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/settings" },
      sourceFile: "src/app/users/web/account/settings.page.tsx",
      layouts: [
        // Renders, and resolves the identity the gate below has nothing to
        // check without.
        {
          module: {
            default: () => null,
            prefix: "/users",
            middleware: [
              () => {
                calls.push("optionalAuth");
              },
            ],
          },
          sourceFile: "src/app/users/web/layout.tsx",
        },
        // No default export: a pure authorization boundary, the shape a
        // `middleware`-only layout has. Classified by the module, so it does
        // NOT count as a second rendering layout.
        {
          module: {
            prefix: "/account",
            middleware: [
              () => {
                calls.push("gate");
              },
            ],
          },
          sourceFile: "src/app/users/web/account/layout.tsx",
        },
      ],
    };

    const { run, registered, built } = install(manifestOf([guardedPage]));

    const installed = run();

    await runLayoutMiddleware(built[0]);

    // The guard runs at all, and it runs AFTER the layout that gives it
    // something to check.
    expect(calls).toEqual(["optionalAuth", "gate"]);

    // ...and every prefix on the path composed, for the same reason: it is one
    // chain walk, not two.
    expect(registered.map((route) => route.path)).toEqual(["/users/account/settings"]);
    expect(installed[0]?.layoutFile).toBe("src/app/users/web/layout.tsx");
  });

  it("hosts the chain on the NEAREST layout when none of them renders", async () => {
    const calls: string[] = [];

    const unwrappedPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/orders" },
      sourceFile: "src/app/shop/web/admin/orders.page.tsx",
      layouts: [
        {
          module: {
            prefix: "/shop",
            middleware: [
              () => {
                calls.push("outer");
              },
            ],
          },
          sourceFile: "src/app/shop/web/layout.tsx",
        },
        {
          module: {
            prefix: "/admin",
            middleware: [
              () => {
                calls.push("inner");
              },
            ],
          },
          sourceFile: "src/app/shop/web/admin/layout.tsx",
        },
      ],
    };

    const { run, registered, built } = install(manifestOf([unwrappedPage]));

    const installed = run();

    await runLayoutMiddleware(built[0]);

    expect(calls).toEqual(["outer", "inner"]);
    expect(registered.map((route) => route.path)).toEqual(["/shop/admin/orders"]);
    expect(installed[0]?.layoutFile).toBe("src/app/shop/web/admin/layout.tsx");
  });

  it("a layout that exports no middleware contributes nothing and does not break the chain", async () => {
    const calls: string[] = [];

    const page: PageManifestPageEntry = {
      module: { default: () => null, route: "/orders" },
      sourceFile: "src/app/shop/web/admin/orders.page.tsx",
      layouts: [
        {
          module: { default: () => null, prefix: "/shop" },
          sourceFile: "src/app/shop/web/layout.tsx",
        },
        {
          module: {
            prefix: "/admin",
            middleware: [
              () => {
                calls.push("gate");
              },
            ],
          },
          sourceFile: "src/app/shop/web/admin/layout.tsx",
        },
      ],
    };

    const { run, registered, built } = install(manifestOf([page]));

    const installed = run();

    await runLayoutMiddleware(built[0]);

    expect(calls).toEqual(["gate"]);
    expect(registered.map((route) => route.path)).toEqual(["/shop/admin/orders"]);
    expect(installed[0]?.layoutFile).toBe("src/app/shop/web/layout.tsx");
  });

  it("leaves a page under ONE layout exactly as it was — that layout's own module, untouched", async () => {
    const layoutModule = {
      default: () => null,
      prefix: "/admin",
      middleware: [() => undefined],
    };

    const page: PageManifestPageEntry = {
      module: { default: () => null, route: "/dashboard" },
      sourceFile: "src/app/main/web/settings/dashboard.page.tsx",
      layouts: [{ module: layoutModule, sourceFile: "src/app/main/web/layout.tsx" }],
    };

    const { run, registered, built } = install(manifestOf([page]));

    run();

    expect(registered[0].path).toBe("/admin/dashboard");
    // Not a copy with the same contents — the exact namespace object the
    // manifest carries, as every other id resolves to.
    await expect(built[0].loadModule("src/app/main/web/layout.tsx")).resolves.toBe(layoutModule);
  });

  it("leaves a page under NO layout exactly as it was — no layout level, no middleware", async () => {
    const page: PageManifestPageEntry = {
      module: { default: () => null, route: "/contact-us" },
      sourceFile: "src/app/main/web/contact-us.page.tsx",
      layouts: [],
    };

    const { run, registered, built } = install(manifestOf([page]));

    run();

    expect(registered[0].path).toBe("/contact-us");
    expect(built[0].layoutFile).toBeUndefined();
    await expect(layoutMiddlewareOf(built[0])).resolves.toEqual([]);
  });

  it("composes the same effective path discoverPages() computes for the same tree", () => {
    // Real sources: discovery PARSES these, so the fixture has to be the thing
    // it reads. The manifest is then built from what discovery reported —
    // which is exactly what the generated barrel does — so the two sides are
    // answering for the same tree rather than for two hand-written guesses.
    const appRoot = makeAppTree({
      "src/app/users/web/layout.tsx":
        'export const prefix = "/users";\nexport default () => null;\n',
      "src/app/users/web/account/layout.tsx":
        'export const prefix = "/account";\nexport const middleware = [() => undefined];\n',
      "src/app/users/web/account/settings.page.tsx":
        'export const route = "/settings";\nexport default () => null;\n',
    });

    const discovered = discoverPages({ appRoot });
    const moduleByLayoutFile: Record<string, Record<string, unknown>> = {
      "src/app/users/web/layout.tsx": { default: () => null, prefix: "/users" },
      "src/app/users/web/account/layout.tsx": {
        prefix: "/account",
        middleware: [() => undefined],
      },
    };

    const { run, registered } = install(
      manifestOf(
        discovered.map((page) => ({
          module: { default: () => null, route: "/settings" },
          sourceFile: toPosix(path.relative(appRoot, page.pageFile)),
          layouts: page.layouts.map((layoutFile) => {
            const sourceFile = toPosix(path.relative(appRoot, layoutFile));

            return { module: moduleByLayoutFile[sourceFile], sourceFile };
          }),
        })),
      ),
    );

    run();

    expect(discovered.map((page) => page.routePath)).toEqual(registered.map((route) => route.path));
    expect(registered[0].path).toBe("/users/account/settings");
  });

  it("registers a middleware-only chain the build accepts, rather than refusing it as nested", () => {
    // The build classifies by the module and lets this through; before
    // classification landed here, boot read every layout as rendering and
    // refused a page its own build had accepted.
    const guardedPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/settings" },
      sourceFile: "src/app/users/web/account/settings.page.tsx",
      layouts: [
        { module: { prefix: "/users" }, sourceFile: "src/app/users/web/layout.tsx" },
        {
          module: { prefix: "/account", middleware: [() => undefined] },
          sourceFile: "src/app/users/web/account/layout.tsx",
        },
      ],
    };

    const { run, registered } = install(manifestOf([guardedPage]));

    expect(run).not.toThrow();
    expect(registered.map((route) => route.path)).toEqual(["/users/account/settings"]);
  });
});

describe("the route table it publishes", () => {
  /*
    THE WIRING, asserted through the installer rather than by calling
    `publishRouteTable` directly.

    A unit test of the route table proves `href` interpolates. It does NOT prove
    that anything ever fills the table, and that is exactly the half that broke:
    the table module was correct and complete while every server-rendered
    `<Link>` threw, because nothing had published. So the assertion that matters
    is made here, on the installer, against the table a component would read.
  */
  beforeEach(() => {
    resetRouteTable();
  });

  it("publishes every installed route, so href() resolves the names it registered", () => {
    install(manifestOf([homePage, productsPage])).run();

    expect(href("main")).toBe("/");
    expect(href("products")).toBe("/products");
  });

  it("publishes the COMPOSED path, not the page's own `route` export", () => {
    /*
      `products.page.tsx` declares `route: "/"`; its layout contributes the
      `/products` prefix. A link resolving to "/" would point at the home page —
      a wrong URL rather than a missing one, which is the harder failure to
      notice.
    */
    install(manifestOf([productsPage])).run();

    expect(href("products")).toBe("/products");
  });

  it("names itself as the publisher, so an empty table can be traced to a mode", () => {
    install(manifestOf([homePage])).run();

    expect(routeTablePublisher()).toBe("installPageRoutesFromManifest (production)");
  });
});
