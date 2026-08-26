import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import * as discoverPagesModule from "../build/discover-pages";
import { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import {
  DuplicateNotFoundPageError,
  frameworkDefaultNotFoundDocument,
  NotFoundPageDeclaresRouteError,
  NOT_FOUND_ROUTE_NAME,
  NOT_FOUND_ROUTE_PATH,
} from "./not-found-page";

/**
 * `installPageRoutes` no longer walks the filesystem itself — every subject
 * (which `*.page.tsx` files exist, under which web root) comes from
 * {@link discoverPagesModule.discoverPageFiles}, the same enumeration
 * production's build shares. This file proves three things about that: the
 * global root (`src/web/**`) is now served exactly like a module's
 * (`src/app/<module>/web/**`); the shared enumerator is consulted exactly
 * once per install; and the installer has no fallback walk of its own — a
 * real page file the enumerator does not report is never served.
 */

const temporaryDirectories: string[] = [];

/** Materialises a fixture app tree: `{ "src/web/dashboard.page.tsx": "" }` under a temp root. */
function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-install-page-routes-"));
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

  vi.restoreAllMocks();
});

type RegisteredRoute = {
  path: string;
  options: { name?: string; isPage?: boolean };
  sourceFile?: string;
};

/**
 * A router double that records every registration; the whole observable output
 * of an install run.
 *
 * The catch-all is recorded SEPARATELY. Every install that finds any page also
 * registers the not-found route (`*`), and it is not one of the pages — it has
 * no declared URL, it is not in the returned table and it is not published for
 * `href()`. Splitting it here keeps `registered` meaning what every case below
 * was written to mean: the pages that declared a path.
 */
function recordingRouter() {
  const registered: RegisteredRoute[] = [];
  const notFound: (RegisteredRoute & { handler: PageRouteHandler })[] = [];
  let sourceFile: string | undefined;

  const router = {
    get(routePath: string, handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      if (routePath === NOT_FOUND_ROUTE_PATH) {
        notFound.push({ path: routePath, options, handler, sourceFile });
      } else {
        registered.push({ path: routePath, options, sourceFile });
      }

      return router;
    },
    async withSourceFile<T>(file: string, callback: () => T | Promise<T>) {
      sourceFile = file;

      try {
        return await callback();
      } finally {
        sourceFile = undefined;
      }
    },
    removeRoutesBySourceFile(file: string) {
      for (const routes of [registered, notFound]) {
        for (let index = routes.length - 1; index >= 0; index--) {
          if (routes[index]?.sourceFile === file) {
            routes.splice(index, 1);
          }
        }
      }
    },
    list: () => [
      ...registered.map((route) => ({
        path: route.path,
        isPage: route.options.isPage,
        sourceFile: route.sourceFile,
      })),
      ...notFound.map((route) => ({
        path: route.path,
        isPage: route.options.isPage,
        sourceFile: route.sourceFile,
      })),
    ],
  } as unknown as Router;

  return { router, registered, notFound };
}

/**
 * A `vite.ssrLoadModule` double keyed by absolute file path — stands in for
 * the real dev Vite instance without needing one to actually transform
 * anything.
 */
function fakeVite(moduleByFile: Record<string, unknown>): InstallPageRoutesOptions["vite"] {
  return {
    ssrLoadModule: vi.fn(async (id: string) => {
      const found = moduleByFile[id];

      if (found === undefined) {
        throw new Error(`fakeVite: no module registered for "${id}"`);
      }

      return found;
    }),
  } as unknown as InstallPageRoutesOptions["vite"];
}

const applyBufferedCookie = vi.fn() as InstallPageRoutesOptions["applyBufferedCookie"];

function install(
  appSrcRoot: string,
  vite: InstallPageRoutesOptions["vite"],
  overrides: Partial<InstallPageRoutesOptions> = {},
) {
  const { router, registered, notFound } = recordingRouter();

  const run = () =>
    installPageRoutes({
      router,
      vite,
      appSrcRoot,
      appFile: path.join(appSrcRoot, "web/root.tsx"),
      applyBufferedCookie,
      ...overrides,
    });

  return { run, router, registered, notFound };
}

describe("installPageRoutes — source-file ownership", () => {
  it("removes only the page owned by an exact canonical source key", async () => {
    const appRoot = makeAppTree({
      "src/web/account.page.tsx": "",
      "src/web/home.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const accountFile = path.join(appSrcRoot, "web", "account.page.tsx");
    const homeFile = path.join(appSrcRoot, "web", "home.page.tsx");
    const vite = fakeVite({
      [accountFile]: { route: "/account" },
      [homeFile]: { route: "/" },
    });

    const { run, router } = install(appSrcRoot, vite);
    await run();

    expect(router.list()).toEqual([
      { path: "/account", isPage: true, sourceFile: "src/web/account.page.tsx" },
      { path: "/", isPage: true, sourceFile: "src/web/home.page.tsx" },
      { path: NOT_FOUND_ROUTE_PATH, isPage: true, sourceFile: undefined },
    ]);

    router.removeRoutesBySourceFile("src/web/account.page.tsx");

    expect(router.list()).toEqual([
      { path: "/", isPage: true, sourceFile: "src/web/home.page.tsx" },
      { path: NOT_FOUND_ROUTE_PATH, isPage: true, sourceFile: undefined },
    ]);
  });

  it("tracks the application 404 catch-all under the 404 page's own source key", async () => {
    const appRoot = makeAppTree({
      "src/web/404.page.tsx": "",
      "src/web/home.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const homeFile = path.join(appSrcRoot, "web", "home.page.tsx");
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");
    const vite = fakeVite({
      [homeFile]: { route: "/" },
      [notFoundFile]: { default: () => null },
    });

    const { run, router } = install(appSrcRoot, vite);
    await run();

    expect(router.list()).toEqual([
      { path: "/", isPage: true, sourceFile: "src/web/home.page.tsx" },
      {
        path: NOT_FOUND_ROUTE_PATH,
        isPage: true,
        sourceFile: "src/web/404.page.tsx",
      },
    ]);

    router.removeRoutesBySourceFile("src/web/404.page.tsx");

    expect(router.list()).toEqual([
      { path: "/", isPage: true, sourceFile: "src/web/home.page.tsx" },
    ]);
  });
});

describe("installPageRoutes — the global root, alongside a module root", () => {
  it("registers a page under src/web/** and a page under src/app/<module>/web/**, from ONE subject list", async () => {
    const appRoot = makeAppTree({
      "src/web/dashboard.page.tsx": "",
      "src/app/main/web/home.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const dashboardFile = path.join(appSrcRoot, "web", "dashboard.page.tsx");
    const homeFile = path.join(appSrcRoot, "app", "main", "web", "home.page.tsx");

    const vite = fakeVite({
      [dashboardFile]: { route: "/dashboard" },
      [homeFile]: { route: "/" },
    });

    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    expect(registered.map((route) => route.path).sort()).toEqual(["/", "/dashboard"]);
    expect(installed.map((page) => page.path).sort()).toEqual(["/", "/dashboard"]);
    expect(installed.find((page) => page.path === "/dashboard")?.file).toBe(dashboardFile);
  });
});

describe("installPageRoutes — a page with no route export", () => {
  it("refuses it by name, with the same error the build throws, instead of silently skipping it", async () => {
    const appRoot = makeAppTree({
      "src/web/contact-us.page.tsx": "",
      "src/web/home.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const contactFile = path.join(appSrcRoot, "web", "contact-us.page.tsx");
    const homeFile = path.join(appSrcRoot, "web", "home.page.tsx");

    const vite = fakeVite({
      [contactFile]: {},
      [homeFile]: { route: "/" },
    });

    const { run, registered } = install(appSrcRoot, vite);

    await expect(run()).rejects.toThrowError(discoverPagesModule.MissingRouteExportError);
    await expect(run()).rejects.toThrowError(/contact-us\.page\.tsx/);
    // The boot fails; it does not half-register the rest of the app behind a warning.
    expect(registered).toEqual([]);
  });
});

describe("installPageRoutes — the shared enumerator is called exactly once", () => {
  it("calls discoverPageFiles(appSrcRoot) exactly once and registers exactly its returned records", async () => {
    const appRoot = makeAppTree({
      "src/web/dashboard.page.tsx": "",
      "src/app/main/web/home.page.tsx": "",
      "src/app/shop/web/items.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const dashboardFile = path.join(appSrcRoot, "web", "dashboard.page.tsx");
    const homeFile = path.join(appSrcRoot, "app", "main", "web", "home.page.tsx");
    const itemsFile = path.join(appSrcRoot, "app", "shop", "web", "items.page.tsx");

    const vite = fakeVite({
      [dashboardFile]: { route: "/dashboard" },
      [homeFile]: { route: "/" },
      [itemsFile]: { route: "/items" },
    });

    const spy = vi.spyOn(discoverPagesModule, "discoverPageFiles");

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(appSrcRoot);

    const returned = spy.mock.results[0]?.value as { pageFile: string; webRoot: string }[];

    // Both roots came back in the one call...
    expect(returned.map((record) => record.pageFile).sort()).toEqual(
      [dashboardFile, homeFile, itemsFile].sort(),
    );
    // ...and every one of them, and only them, made it onto the router.
    expect(registered.map((route) => route.path).sort()).toEqual(["/", "/dashboard", "/items"]);
  });
});

describe("installPageRoutes — ancestor layout composition", () => {
  it("composes against the nearest ancestor layout's prefix when the page's own directory has none", async () => {
    const appRoot = makeAppTree({
      "src/app/main/web/layout.tsx": "",
      "src/app/main/web/settings/dashboard.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const webRoot = path.join(appSrcRoot, "app", "main", "web");
    const layoutFile = path.join(webRoot, "layout.tsx");
    const pageFile = path.join(webRoot, "settings", "dashboard.page.tsx");

    const vite = fakeVite({
      [pageFile]: { route: "/settings" },
      [layoutFile]: { prefix: "/admin" },
    });

    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    expect(registered.map((route) => route.path)).toEqual(["/admin/settings"]);
    expect(installed[0]?.path).toBe("/admin/settings");
    expect(installed[0]?.layoutFile).toBe(layoutFile);
  });
});

describe("installPageRoutes — no independent filesystem enumeration", () => {
  it("serves ONLY what the stubbed enumerator returns — a real page file it omits is never registered", async () => {
    const appRoot = makeAppTree({
      // A real page on disk, under the global root, that the stub below will
      // NOT report. If the installer still had — or ever grows back — a
      // filesystem walk of its own, this file would surface anyway.
      "src/web/dashboard.page.tsx": "",
      "src/app/main/web/home.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const dashboardFile = path.join(appSrcRoot, "web", "dashboard.page.tsx");
    const homeFile = path.join(appSrcRoot, "app", "main", "web", "home.page.tsx");
    const homeWebRoot = path.join(appSrcRoot, "app", "main", "web");

    const vite = fakeVite({
      [dashboardFile]: { route: "/dashboard" },
      [homeFile]: { route: "/" },
    });

    vi.spyOn(discoverPagesModule, "discoverPageFiles").mockReturnValue([
      { pageFile: homeFile, webRoot: homeWebRoot },
    ]);

    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    // Only the crafted list's one record registered...
    expect(registered.map((route) => route.path)).toEqual(["/"]);
    expect(installed.map((page) => page.file)).toEqual([homeFile]);

    // ...and the real, on-disk global-root page the stub omitted — /dashboard —
    // never reached the router, even though `fs.existsSync(dashboardFile)` is
    // true right now.
    expect(fs.existsSync(dashboardFile)).toBe(true);
    expect(registered.some((route) => route.path === "/dashboard")).toBe(false);
  });
});

/**
 * Captures the options the installer builds each page's handler from. The
 * layout level reaches the render pipeline through exactly two of them —
 * `layoutFile` (the id) and `loadModule` (what answers that id) — so capturing
 * the pair is how a spec observes the layout middleware chain without standing
 * a render up behind it.
 */
function captureHandlerOptions(): PageRouteHandlerOptions[] {
  const captured: PageRouteHandlerOptions[] = [];

  vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
    handlerOptions => {
      captured.push(handlerOptions);

      return (async () => {}) as PageRouteHandler;
    },
  );

  return captured;
}

/** The middleware array the pipeline would run for a page's layout level, in pipeline order. */
async function layoutMiddlewareOf(handlerOptions: PageRouteHandlerOptions) {
  if (handlerOptions.layoutFile === undefined) return [];

  const layoutModule = (await handlerOptions.loadModule(handlerOptions.layoutFile)) as {
    middleware?: readonly ((context: unknown) => unknown)[];
  };

  return [...(layoutModule.middleware ?? [])];
}

/**
 * Runs that array the way stage 3 does — sequentially, in array order
 * (`execute-page-request.ts:519-524`) — so the assertions below are on OBSERVED
 * call order, not on membership of a list.
 */
async function runLayoutMiddleware(handlerOptions: PageRouteHandlerOptions) {
  for (const middleware of await layoutMiddlewareOf(handlerOptions)) {
    await middleware({});
  }
}

describe("installPageRoutes — the layout middleware chain", () => {
  it("runs EVERY layout's middleware, outermost first — the outer layout renders, the inner one only guards", async () => {
    const appRoot = makeAppTree({
      "src/app/users/web/layout.tsx": "",
      "src/app/users/web/account/layout.tsx": "",
      "src/app/users/web/account/settings.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const webRoot = path.join(appSrcRoot, "app", "users", "web");
    const usersLayoutFile = path.join(webRoot, "layout.tsx");
    const accountLayoutFile = path.join(webRoot, "account", "layout.tsx");
    const pageFile = path.join(webRoot, "account", "settings.page.tsx");

    const calls: string[] = [];

    const vite = fakeVite({
      [pageFile]: { route: "/settings" },
      // Renders, and resolves the identity the gate below has nothing to check
      // without.
      [usersLayoutFile]: {
        default: () => null,
        prefix: "/users",
        middleware: [
          () => {
            calls.push("optionalAuth");
          },
        ],
      },
      // No default export: a pure authorization boundary, the shape a
      // `middleware`-only layout has.
      [accountLayoutFile]: {
        prefix: "/account",
        middleware: [
          () => {
            calls.push("gate");
          },
        ],
      },
    });

    const captured = captureHandlerOptions();
    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    await runLayoutMiddleware(captured[0]);

    // The guard runs at all, and it runs AFTER the layout that gives it
    // something to check.
    expect(calls).toEqual(["optionalAuth", "gate"]);

    // ...and every prefix on the path composed, for the same reason: it is one
    // chain walk, not two.
    expect(registered.map(route => route.path)).toEqual(["/users/account/settings"]);
    expect(installed[0]?.path).toBe("/users/account/settings");
    // The page still renders inside the one layout that renders.
    expect(installed[0]?.layoutFile).toBe(usersLayoutFile);
  });

  it("leaves a page under ONE layout exactly as it was — that layout's middleware, that layout's prefix", async () => {
    const appRoot = makeAppTree({
      "src/app/main/web/layout.tsx": "",
      "src/app/main/web/settings/dashboard.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const webRoot = path.join(appSrcRoot, "app", "main", "web");
    const layoutFile = path.join(webRoot, "layout.tsx");
    const pageFile = path.join(webRoot, "settings", "dashboard.page.tsx");

    const calls: string[] = [];

    const vite = fakeVite({
      [pageFile]: { route: "/settings" },
      [layoutFile]: {
        default: () => null,
        prefix: "/admin",
        middleware: [
          () => {
            calls.push("only");
          },
        ],
      },
    });

    const captured = captureHandlerOptions();
    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    await runLayoutMiddleware(captured[0]);

    expect(calls).toEqual(["only"]);
    expect(registered.map(route => route.path)).toEqual(["/admin/settings"]);
    expect(installed[0]?.layoutFile).toBe(layoutFile);
  });

  it("leaves a page under NO layout exactly as it was — no layout level, no middleware", async () => {
    const appRoot = makeAppTree({ "src/app/main/web/contact-us.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const pageFile = path.join(appSrcRoot, "app", "main", "web", "contact-us.page.tsx");

    const vite = fakeVite({ [pageFile]: { route: "/contact-us" } });

    const captured = captureHandlerOptions();
    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    expect(registered.map(route => route.path)).toEqual(["/contact-us"]);
    expect(installed[0]?.layoutFile).toBeUndefined();
    expect(captured[0]?.layoutFile).toBeUndefined();
    await expect(layoutMiddlewareOf(captured[0])).resolves.toEqual([]);
  });

  it("a layout that exports no middleware contributes nothing and does not break the chain", async () => {
    const appRoot = makeAppTree({
      "src/app/shop/web/layout.tsx": "",
      "src/app/shop/web/admin/layout.tsx": "",
      "src/app/shop/web/admin/orders.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const webRoot = path.join(appSrcRoot, "app", "shop", "web");
    const shopLayoutFile = path.join(webRoot, "layout.tsx");
    const adminLayoutFile = path.join(webRoot, "admin", "layout.tsx");
    const pageFile = path.join(webRoot, "admin", "orders.page.tsx");

    const calls: string[] = [];

    const vite = fakeVite({
      [pageFile]: { route: "/orders" },
      // Renders, and declares nothing else at all.
      [shopLayoutFile]: { default: () => null, prefix: "/shop" },
      [adminLayoutFile]: {
        prefix: "/admin",
        middleware: [
          () => {
            calls.push("gate");
          },
        ],
      },
    });

    const captured = captureHandlerOptions();
    const { run, registered } = install(appSrcRoot, vite);
    const installed = await run();

    await runLayoutMiddleware(captured[0]);

    expect(calls).toEqual(["gate"]);
    expect(registered.map(route => route.path)).toEqual(["/shop/admin/orders"]);
    expect(installed[0]?.layoutFile).toBe(shopLayoutFile);
  });

  it("refuses a chain with two RENDERING layouts, with the layout policy's one error contract", async () => {
    const appRoot = makeAppTree({
      "src/app/shop/web/layout.tsx": "",
      "src/app/shop/web/admin/layout.tsx": "",
      "src/app/shop/web/admin/orders.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const webRoot = path.join(appSrcRoot, "app", "shop", "web");
    const pageFile = path.join(webRoot, "admin", "orders.page.tsx");

    const vite = fakeVite({
      [pageFile]: { route: "/orders" },
      [path.join(webRoot, "layout.tsx")]: { default: () => null },
      [path.join(webRoot, "admin", "layout.tsx")]: { default: () => null },
    });

    const { run } = install(appSrcRoot, vite);

    await expect(run()).rejects.toBeInstanceOf(NestedLayoutsNotSupportedError);
  });
});

describe("installPageRoutes — dev's URL is discovery's URL", () => {
  it("composes the same effective path discoverPages() computes for the same tree", async () => {
    // Real sources: discovery PARSES these, so the fixture has to be the thing
    // it reads, not a module double.
    const appRoot = makeAppTree({
      "src/app/users/web/layout.tsx":
        'export const prefix = "/users";\nexport default () => null;\n',
      "src/app/users/web/account/layout.tsx": 'export const prefix = "/account";\n',
      "src/app/users/web/account/settings.page.tsx": 'export const route = "/settings";\n',
    });
    const appSrcRoot = path.join(appRoot, "src");
    const webRoot = path.join(appSrcRoot, "app", "users", "web");
    const pageFile = path.join(webRoot, "account", "settings.page.tsx");

    const vite = fakeVite({
      [pageFile]: { route: "/settings" },
      [path.join(webRoot, "layout.tsx")]: { prefix: "/users", default: () => null },
      [path.join(webRoot, "account", "layout.tsx")]: { prefix: "/account" },
    });

    const { run } = install(appSrcRoot, vite);
    const installed = await run();

    const discovered = discoverPagesModule.discoverPages({ appRoot });

    expect(discovered.map(page => page.routePath)).toEqual([installed[0]?.path]);
    expect(installed[0]?.path).toBe("/users/account/settings");
  });
});

/**
 * THE NOT-FOUND ROUTE, development half — the same three properties production
 * proves, against a Vite-backed loader instead of a manifest.
 */
describe("installPageRoutes — the not-found page", () => {
  it("registers the catch-all last, under the reserved name, and never at /404", async () => {
    const appRoot = makeAppTree({
      "src/web/home.page.tsx": "",
      "src/web/404.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const homeFile = path.join(appSrcRoot, "web", "home.page.tsx");
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");

    const vite = fakeVite({
      [homeFile]: { route: "/" },
      // No `route` export — the whole point.
      [notFoundFile]: { default: () => null },
    });

    const { run, registered, notFound } = install(appSrcRoot, vite);
    const installed = await run();

    expect(registered.map((route) => route.path)).toEqual(["/"]);
    expect(registered.some((route) => route.path === "/404")).toBe(false);
    expect(notFound).toHaveLength(1);
    expect(notFound[0].options).toEqual({ name: NOT_FOUND_ROUTE_NAME, isPage: true });
    // Not in the returned table either, so `href()` cannot resolve it.
    expect(installed.map((page) => page.file)).toEqual([homeFile]);
  });

  it("does not refuse it for lacking a route export, the way it refuses every other page", async () => {
    const appRoot = makeAppTree({ "src/web/404.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");

    const vite = fakeVite({ [notFoundFile]: { default: () => null } });

    const { run, registered, notFound } = install(appSrcRoot, vite);

    await expect(run()).resolves.toEqual([]);
    expect(registered).toEqual([]);
    expect(notFound).toHaveLength(1);
  });

  it("builds its handler with no layout, the request's own path as the pattern, and a 404 status", async () => {
    const appRoot = makeAppTree({
      "src/web/home.page.tsx": "",
      "src/web/layout.tsx": "",
      "src/web/404.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const homeFile = path.join(appSrcRoot, "web", "home.page.tsx");
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");

    const vite = fakeVite({
      [homeFile]: { route: "/" },
      [notFoundFile]: { default: () => null },
      [path.join(appSrcRoot, "web", "layout.tsx")]: { default: () => null },
    });

    const built: PageRouteHandlerOptions[] = [];
    vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
      (options: PageRouteHandlerOptions): PageRouteHandler => {
        built.push(options);

        return async () => undefined;
      },
    );

    const { run } = install(appSrcRoot, vite);
    await run();

    const handler = built.find((options) => options.pageFile === notFoundFile);

    expect(handler).toBeDefined();
    // A layout brings its whole chain's middleware, and a guard that redirects
    // on the not-found path turns a missing page into an incident.
    expect(handler?.layoutFile).toBeUndefined();
    expect(handler?.statusForRenderedOk).toBe(404);
    expect(handler?.matchPath?.("/anything/at/all")).toBe("/anything/at/all");
  });

  it("registers the catch-all even when the application ships no 404 page", async () => {
    const appRoot = makeAppTree({ "src/web/home.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");

    const vite = fakeVite({ [path.join(appSrcRoot, "web", "home.page.tsx")]: { route: "/" } });

    const { run, notFound } = install(appSrcRoot, vite);
    await run();

    expect(notFound).toHaveLength(1);
  });

  it("answers the framework default document, with a 404 status, when there is no 404 page", async () => {
    const appRoot = makeAppTree({ "src/web/home.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");

    const vite = fakeVite({ [path.join(appSrcRoot, "web", "home.page.tsx")]: { route: "/" } });

    const { run, notFound } = install(appSrcRoot, vite);
    await run();

    const sent: { body: unknown; status?: number }[] = [];

    await notFound[0].handler({
      // A browser navigation — the one request shape that opens the page path.
      request: { method: "GET", path: "/nope", header: () => "text/html" },
      response: {
        html: async (body: string, status?: number) => {
          sent.push({ body, status });
        },
      },
    } as never);

    expect(sent).toEqual([{ body: frameworkDefaultNotFoundDocument(), status: 404 }]);
  });

  it("registers nothing at all for an application with no pages", async () => {
    const appRoot = makeAppTree({ "src/web/root.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");

    const { run, registered, notFound } = install(appSrcRoot, fakeVite({}));
    await run();

    expect(registered).toEqual([]);
    expect(notFound).toEqual([]);
  });

  it("refuses two not-found pages by name rather than letting walk order pick one", async () => {
    const appRoot = makeAppTree({
      "src/web/404.page.tsx": "",
      "src/app/shop/web/404.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");

    const { run, registered, notFound } = install(appSrcRoot, fakeVite({}));

    await expect(run()).rejects.toThrowError(DuplicateNotFoundPageError);
    await expect(run()).rejects.toThrowError(/404\.page\.tsx/);
    expect(registered).toEqual([]);
    expect(notFound).toEqual([]);
  });

  it("refuses a not-found page that declares a route export, at install time", async () => {
    const appRoot = makeAppTree({ "src/web/404.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");

    const vite = fakeVite({ [notFoundFile]: { default: () => null, route: "/404" } });

    const { run, notFound } = install(appSrcRoot, vite);

    await expect(run()).rejects.toThrowError(NotFoundPageDeclaresRouteError);
    // Refused at boot, not on the first request that misses.
    expect(notFound).toEqual([]);
  });
});
