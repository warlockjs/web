import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverPages, isDiscoveredRoutablePage, toPosix } from "../build/discover-pages";
import { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
import { href, resetRouteTable, routeTablePublisher } from "../routing/route-table";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import {
  DuplicateNotFoundPageError,
  frameworkDefaultNotFoundDocument,
  NotFoundPageDeclaresRouteError,
  NOT_FOUND_ROUTE_NAME,
  NOT_FOUND_ROUTE_PATH,
} from "./not-found-page";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";
import {
  createBufferedResponse,
  createLevelBuffer,
  isLoaderShortCircuit,
} from "./settle-page-response";

type RegisteredRoute = {
  path: string;
  handler: PageRouteHandler;
  options: { name?: string; isPage?: boolean };
};

/**
 * A router stand-in that records what was registered. Registration is the whole
 * observable output of this module, so the double only has to remember it.
 *
 * The catch-all is recorded SEPARATELY. Every install registers the not-found
 * route (`*`) whether or not the build carried a `404.page.tsx`, and it is not
 * one of the pages — no declared URL, not in the returned table, not published
 * for `href()`. Keeping it out of `registered` keeps that array meaning what
 * every case below was written to mean: the pages that declared a path.
 */
function recordingRouter(apiRoutes: readonly string[] = []) {
  const registered: RegisteredRoute[] = [];
  const notFound: RegisteredRoute[] = [];

  const router = {
    get(path: string, handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      (path === NOT_FOUND_ROUTE_PATH ? notFound : registered).push({ path, handler, options });
    },
    // `apiRoutes` stands for the routes the APPLICATION registered on the same
    // router — pages and API share one namespace, and the not-found route's rule
    // is computed from exactly this table.
    list: () => [
      ...apiRoutes.map((path) => ({ path, isPage: false })),
      ...[...registered, ...notFound].map((route) => ({
        path: route.path,
        isPage: route.options.isPage,
      })),
    ],
  } as unknown as InstallPageRoutesFromManifestOptions["router"];

  return { router, registered, notFound };
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

/** Writes `<root>/.vite/manifest.json` under a fresh client dir and returns the client dir. */
function makeClientDir(manifest: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-install-from-manifest-client-"));
  temporaryDirectories.push(root);

  const viteDir = path.join(root, ".vite");
  fs.mkdirSync(viteDir, { recursive: true });
  fs.writeFileSync(path.join(viteDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

  return root;
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
  apiRoutes: readonly string[] = [],
) {
  const { router, registered, notFound } = recordingRouter(apiRoutes);
  const { createHandler, built } = recordingHandlerFactory();

  const run = () =>
    installPageRoutesFromManifest({
      router,
      manifest,
      createHandler,
      ...overrides,
    });

  return { run, registered, notFound, built };
}

describe("production page route installation", () => {
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

  it("registers a page module with no route export under the derived filesystem path and dotted name", () => {
    const page: PageManifestPageEntry = {
      module: { default: () => null },
      sourceFile: "src/web/main/draft.page.tsx",
      layouts: [],
    };

    const { run, registered, built } = install(manifestOf([page]));

    const installed = run();

    expect(registered).toHaveLength(1);
    expect(registered[0].path).toBe("/main/draft");
    expect(registered[0].options.name).toBe("main.draft");
    expect(installed).toEqual([
      {
        declaredPath: "/main/draft",
        path: "/main/draft",
        name: "main.draft",
        file: "src/web/main/draft.page.tsx",
        layoutFile: undefined,
      },
    ]);
  });

  it("derives the path for an unrouted page under a prefix-exporting layout at the prefix-replaced path, not doubled", () => {
    const docsLayout = {
      module: { default: () => null, prefix: "/docs" },
      sourceFile: "src/web/docs/layout.tsx",
    };

    const page: PageManifestPageEntry = {
      module: { default: () => null },
      sourceFile: "src/web/docs/guide.page.tsx",
      layouts: [docsLayout],
    };

    const { run, registered } = install(manifestOf([page]));

    run();

    expect(registered).toHaveLength(1);
    expect(registered[0].path).toBe("/docs/guide");
    expect(registered[0].options.name).toBe("docs.guide");
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

  it("forwards the hydration client module url to each handler", () => {
    const { run, built } = install(manifestOf([homePage]), {
      hydrationClientModuleUrl: "/assets/hydrate.js",
    });

    run();

    expect(built[0].hydrationClientModuleUrl).toBe("/assets/hydrate.js");
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

    const outerModule = {
      default: () => null,
      prefix: "/users",
      middleware: [
        () => {
          calls.push("optionalAuth");
        },
      ],
    };
    const innerModule = {
      prefix: "/account",
      middleware: [
        () => {
          calls.push("gate");
        },
      ],
    };

    const guardedPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/settings" },
      sourceFile: "src/app/users/web/account/settings.page.tsx",
      layouts: [
        // Renders, and resolves the identity the gate below has nothing to
        // check without.
        {
          module: outerModule,
          sourceFile: "src/app/users/web/layout.tsx",
        },
        // No default export: a pure authorization boundary, the shape a
        // `middleware`-only layout has. Classified by the module, so it does
        // NOT count as a second rendering layout.
        {
          module: innerModule,
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

    const registrationLayouts = await built[0].loadRegistrationLayouts?.();
    expect(registrationLayouts).toHaveLength(2);
    expect(registrationLayouts?.[0]).toBe(outerModule);
    expect(registrationLayouts?.[1]).toBe(innerModule);
    await expect(built[0].loadModule("src/app/users/web/layout.tsx")).resolves.not.toBe(
      outerModule,
    );
  });

  it("stops a composed layout loader chain when an outer loader redirects", async () => {
    const innerLoader = vi.fn(() => ({ mustNotRun: true }));
    const page: PageManifestPageEntry = {
      module: { default: () => null, route: "/settings" },
      sourceFile: "src/app/users/web/account/settings.page.tsx",
      layouts: [
        {
          module: {
            default: () => null,
            loader: ({ response }: any) => response.redirect("/login"),
          },
          sourceFile: "src/app/users/web/layout.tsx",
        },
        {
          module: { loader: innerLoader },
          sourceFile: "src/app/users/web/account/layout.tsx",
        },
      ],
    };
    const { run, built } = install(manifestOf([page]));

    run();

    const composed = (await built[0].loadModule("src/app/users/web/layout.tsx")) as {
      loader?: (context: unknown) => unknown;
    };
    const result = await composed.loader?.({
      request: {},
      response: createBufferedResponse(createLevelBuffer()),
      shared: {},
    });

    expect(isLoaderShortCircuit(result)).toBe(true);
    expect(innerLoader).not.toHaveBeenCalled();
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
    await expect(built[0].loadRegistrationLayouts?.()).resolves.toEqual([]);
  });

  it("composes the same effective path discoverPages() computes for the same tree", () => {
    // Real sources: discovery PARSES these, so the fixture has to be the thing
    // it reads. The manifest is then built from what discovery reported —
    // which is exactly what the generated barrel does — so the two sides are
    // answering for the same tree rather than for two hand-written guesses.
    const appRoot = makeAppTree({
      "src/web/layout.tsx": 'export const prefix = "/users";\nexport default () => null;\n',
      "src/web/account/layout.tsx":
        'export const prefix = "/account";\nexport const middleware = [() => undefined];\n',
      "src/web/account/settings.page.tsx":
        'export const route = "/settings";\nexport default () => null;\n',
    });

    const discovered = discoverPages({ appRoot }).filter(isDiscoveredRoutablePage);
    const moduleByLayoutFile: Record<string, Record<string, unknown>> = {
      "src/web/layout.tsx": { default: () => null, prefix: "/users" },
      "src/web/account/layout.tsx": {
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

  it("names itself as the publisher, so an empty table can be traced to a mode", () => {
    install(manifestOf([homePage])).run();

    expect(routeTablePublisher()).toBe("installPageRoutesFromManifest (production)");
  });
});

/**
 * THE NOT-FOUND ROUTE, production half.
 *
 * The properties that matter are the same three in both modes: the page is not
 * registered at a URL of its own, the catch-all is registered whether or not the
 * application wrote one, and the handler is built with no layout and a 404 for a
 * rendered-OK status.
 */
describe("installPageRoutesFromManifest — the not-found page", () => {
  const notFoundPage: PageManifestPageEntry = {
    module: { default: () => null },
    sourceFile: "src/app/main/web/404.page.tsx",
    layouts: [homeLayout],
  };

  it("registers the catch-all last, under the reserved name, marked as a page", () => {
    const { run, registered, notFound } = install(manifestOf([homePage, notFoundPage]));

    run();

    // The 404 page is NOT one of the registered pages — no `/404`, no path of
    // its own, nothing derived from its filename.
    expect(registered.map((route) => route.path)).toEqual(["/"]);
    expect(notFound).toHaveLength(1);
    expect(notFound[0].path).toBe(NOT_FOUND_ROUTE_PATH);
    expect(notFound[0].options).toEqual({ name: NOT_FOUND_ROUTE_NAME, isPage: true });
  });

  it("keeps the not-found page out of the returned table, so href() cannot point at it", () => {
    const { run } = install(manifestOf([homePage, notFoundPage]));

    const installed = run();

    expect(installed.map((page) => page.file)).toEqual(["src/app/main/web/home.page.tsx"]);
    expect(() => href(NOT_FOUND_ROUTE_NAME)).toThrowError();
  });

  it("builds its handler with no layout, the request's own path as the pattern, and a 404 status", () => {
    const { run, built } = install(manifestOf([homePage, notFoundPage]));

    run();

    const handler = built.find((options) => options.pageFile === notFoundPage.sourceFile);

    expect(handler).toBeDefined();
    expect(handler?.layoutFile).toBeUndefined();
    expect(handler?.loadRegistrationLayouts).toBeUndefined();
    expect(handler?.name).toBe(NOT_FOUND_ROUTE_NAME);
    expect(handler?.statusForRenderedOk).toBe(404);
    expect(handler?.skipPageLoader).toBe(true);
    expect(handler?.matchPath?.("/anything/at/all")).toBe("/anything/at/all");
  });

  it("registers the catch-all even with no 404 page in the build — the framework default still answers 404", () => {
    const { run, notFound, built } = install(manifestOf([homePage]));

    run();

    expect(notFound).toHaveLength(1);
    // No page handler was built for it: there is no page to build one from.
    expect(built.map((options) => options.pageFile)).toEqual(["src/app/main/web/home.page.tsx"]);
  });

  it("registers nothing at all for a build that discovered no pages", () => {
    const { run, registered, notFound } = install(manifestOf([]));

    run();

    expect(registered).toEqual([]);
    // "Configured with web, no pages yet" is legal, and an application with no
    // page surface has no page 404 to answer with.
    expect(notFound).toEqual([]);
  });

  it("refuses two not-found pages by name rather than letting walk order pick one", () => {
    const second: PageManifestPageEntry = {
      module: { default: () => null },
      sourceFile: "src/app/shop/web/404.page.tsx",
      layouts: [],
    };

    const { run, registered } = install(manifestOf([homePage, notFoundPage, second]));

    expect(() => run()).toThrowError(DuplicateNotFoundPageError);
    expect(() => run()).toThrowError(/src\/app\/shop\/web\/404\.page\.tsx/);
    // Refused before anything was registered.
    expect(registered).toEqual([]);
  });

  it("refuses a not-found page that declares a route export — it has no URL to promise", () => {
    const withRoute: PageManifestPageEntry = {
      module: { default: () => null, route: "/404" },
      sourceFile: "src/app/main/web/404.page.tsx",
      layouts: [],
    };

    const { run, registered } = install(manifestOf([homePage, withRoute]));

    expect(() => run()).toThrowError(NotFoundPageDeclaresRouteError);
    expect(registered).toEqual([]);
  });

  it("answers a bare fetch() with JSON through the registered handler", async () => {
    const { run, notFound } = install(manifestOf([homePage, notFoundPage]), {}, ["/api/users"]);

    run();

    const sent: { body: unknown; status?: number }[] = [];
    const headers = new Map<string, unknown>();
    const context = {
      // `*/*` is what `fetch()` sends: no explicit `text/html`, so JSON.
      request: { method: "GET", path: "/api/uzers", header: () => "*/*" },
      response: {
        header: vi.fn((name: string, value: unknown) => {
          headers.set(name.toLowerCase(), value);
        }),
        send: async (body: unknown, status?: number) => {
          sent.push({ body, status });
        },
      },
    };

    // The caller named no media type it wanted, so the document path is never
    // entered — whatever the path happens to look like.
    await notFound[0].handler(context as never);

    expect(sent).toEqual([
      {
        status: 404,
        body: { error: "Route not found", path: "/api/uzers", method: "GET" },
      },
    ]);
    expect(headers.get("cache-control")).toBe("no-store");
  });
});

/**
 * ROUTE-LOCAL SSR CSS, production half.
 *
 * `productionStylesheetUrls` (`stylesheet-urls.ts`) is unit-tested on its own;
 * these specs prove the WIRING — that `installPageRoutesFromManifest` calls it
 * per page with the manifest's own `[app.sourceFile, ...layouts, page]` chain,
 * against a real `.vite/manifest.json` on disk, and that the not-found page
 * never gets a sibling layout's CSS it never got that layout's middleware
 * from.
 */
describe("installPageRoutesFromManifest — route-local CSS", () => {
  it("gives a page with no layout only root's and its own stylesheets", () => {
    const contactPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/contact-us" },
      sourceFile: "src/app/main/web/contact-us.page.tsx",
      layouts: [],
    };
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root.js", css: ["assets/root.css"] },
      "src/app/main/web/contact-us.page.tsx": {
        file: "assets/contact-us.page.js",
        css: ["assets/contact-us.page.css"],
      },
    });

    const { run, built } = install(manifestOf([contactPage]), { clientDir });

    run();

    expect(built[0].stylesheetUrls).toEqual(["/assets/root.css", "/assets/contact-us.page.css"]);
  });

  it("carries every matched layout's stylesheets, outer to inner, between root and the page", () => {
    const guardedPage: PageManifestPageEntry = {
      module: { default: () => null, route: "/settings" },
      sourceFile: "src/app/users/web/account/settings.page.tsx",
      layouts: [
        { module: { default: () => null }, sourceFile: "src/app/users/web/layout.tsx" },
        { module: {}, sourceFile: "src/app/users/web/account/layout.tsx" },
      ],
    };
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root.js", css: ["assets/root.css"] },
      "src/app/users/web/layout.tsx": { file: "assets/outer.js", css: ["assets/outer.css"] },
      "src/app/users/web/account/layout.tsx": {
        file: "assets/inner.js",
        css: ["assets/inner.css"],
      },
      "src/app/users/web/account/settings.page.tsx": {
        file: "assets/settings.page.js",
        css: ["assets/settings.page.css"],
      },
    });

    const { run, built } = install(manifestOf([guardedPage]), { clientDir });

    run();

    expect(built[0].stylesheetUrls).toEqual([
      "/assets/root.css",
      "/assets/outer.css",
      "/assets/inner.css",
      "/assets/settings.page.css",
    ]);
  });

  it("gives the not-found page's handler root and its own stylesheets, never a sibling layout's", () => {
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root.js", css: ["assets/root.css"] },
      "src/app/main/web/layout.tsx": { file: "assets/layout.js", css: ["assets/layout.css"] },
      "src/app/main/web/home.page.tsx": { file: "assets/home.page.js", css: ["assets/home.page.css"] },
      "src/app/main/web/404.page.tsx": { file: "assets/404.page.js", css: ["assets/404.page.css"] },
    });

    const notFoundPage: PageManifestPageEntry = {
      module: { default: () => null },
      sourceFile: "src/app/main/web/404.page.tsx",
      layouts: [homeLayout],
    };

    const { run, built } = install(manifestOf([homePage, notFoundPage]), { clientDir });

    run();

    const homeHandler = built.find((options) => options.pageFile === homePage.sourceFile);
    const notFoundHandler = built.find((options) => options.pageFile === notFoundPage.sourceFile);

    expect(homeHandler?.stylesheetUrls).toEqual(["/assets/root.css", "/assets/layout.css", "/assets/home.page.css"]);
    // No `/assets/layout.css` here — the not-found page renders inside the
    // application root and nothing else, exactly as it has no layout middleware.
    expect(notFoundHandler?.stylesheetUrls).toEqual(["/assets/root.css", "/assets/404.page.css"]);
  });

  it("gives every page no stylesheets when the build carried no client bundle", () => {
    const { run, built } = install(manifestOf([homePage]));

    run();

    expect(built[0].stylesheetUrls).toEqual([]);
  });
});
