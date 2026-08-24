import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "../../../core/src/router/router";
import * as discoverPagesModule from "../build/discover-pages";
import { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";

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

type RegisteredRoute = { path: string; options: { name?: string; isPage?: boolean } };

/** A router double that records every registration; the whole observable output of an install run. */
function recordingRouter() {
  const registered: RegisteredRoute[] = [];

  const router = {
    get(routePath: string, _handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      registered.push({ path: routePath, options });
      return router;
    },
  } as unknown as Router;

  return { router, registered };
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
  const { router, registered } = recordingRouter();

  const run = () =>
    installPageRoutes({
      router,
      vite,
      appSrcRoot,
      appFile: path.join(appSrcRoot, "web/root.tsx"),
      applyBufferedCookie,
      ...overrides,
    });

  return { run, registered };
}

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
