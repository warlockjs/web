import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "@mongez/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import { ErrorPageDeclaresRouteError } from "../routing/error-page-declares-route-error";
import * as routeHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import { installPageRoutesFromManifest } from "./install-page-routes-from-manifest";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-page-config-parity-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }

  return appRoot;
}

type RegisteredRoute = { path: string; options: { name?: string; isPage?: boolean } };

function recordingRouter() {
  const registered: RegisteredRoute[] = [];
  const router = {
    get(path: string, _handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      if (path !== "*") registered.push({ path, options });
      return router;
    },
    async withSourceFile<T>(_sourceFile: string, callback: () => T | Promise<T>) {
      return await callback();
    },
    removeRoutesBySourceFile() {},
    list: () => [],
  } as unknown as Router;

  return { router, registered };
}

function captureHandlerFactory() {
  const built: PageRouteHandlerOptions[] = [];
  const createHandler = (options: PageRouteHandlerOptions): PageRouteHandler => {
    built.push(options);
    return async () => undefined;
  };
  return { built, createHandler };
}

function pageModule(config: Record<string, unknown>) {
  return { config, default: () => null };
}

const guard = () => undefined;
const layoutModule = {
  config: { prefix: "/admin", middleware: [guard], metadata: { robots: "noindex" } },
  default: () => null,
};
const pageConfig = {
  route: { path: "/reports", name: "admin.reports" },
  cache: { public: true as const, maxAge: 60 },
  metadata: { title: "Reports" },
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
  config.set("web", {});
  config.set("app", {});
  vi.restoreAllMocks();
});

describe("page config installer parity", () => {
  it("gives dev and production the same route, cache and composed-layout view", async () => {
    const appRoot = makeAppTree({
      "src/web/admin/layout.tsx": "",
      "src/web/admin/reports.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const layoutFile = path.join(appSrcRoot, "web/admin/layout.tsx");
    const pageFile = path.join(appSrcRoot, "web/admin/reports.page.tsx");
    const rootFile = path.join(appSrcRoot, "web/root.tsx");
    const rawRoot = { config: { middleware: [guard] }, default: () => null };
    const rawPage = pageModule(pageConfig);
    const modules: Record<string, unknown> = {
      [rootFile]: rawRoot,
      [layoutFile]: layoutModule,
      [pageFile]: rawPage,
    };
    const vite = {
      ssrLoadModule: vi.fn(async (id: string) => modules[id]),
      moduleGraph: undefined,
    } as unknown as InstallPageRoutesOptions["vite"];
    const devRouter = recordingRouter();
    const devCapture = captureHandlerFactory();
    vi.spyOn(routeHandlerModule, "createPageRouteHandler").mockImplementation(
      devCapture.createHandler,
    );

    await installPageRoutes({
      router: devRouter.router,
      vite,
      appSrcRoot,
      appFile: rootFile,
    });

    const manifestPage: PageManifestPageEntry = {
      sourceFile: "src/web/admin/reports.page.tsx",
      module: rawPage,
      layouts: [{ sourceFile: "src/web/admin/layout.tsx", module: layoutModule }],
    };
    const productionManifest: PageManifest = {
      app: { sourceFile: "src/web/root.tsx", module: rawRoot },
      pages: [manifestPage],
    };
    const productionRouter = recordingRouter();
    const productionCapture = captureHandlerFactory();

    installPageRoutesFromManifest({
      router: productionRouter.router,
      manifest: productionManifest,
      createHandler: productionCapture.createHandler,
    });

    expect(devRouter.registered).toEqual([
      { path: "/admin/reports", options: { name: "admin.reports", isPage: true } },
    ]);
    expect(productionRouter.registered).toEqual(devRouter.registered);

    const [dev] = devCapture.built;
    const [production] = productionCapture.built;
    expect(dev?.cache).toEqual({ public: true, maxAge: 60 });
    expect(production?.cache).toEqual(dev?.cache);
    expect(await dev?.loadRegistrationLayouts?.()).toEqual([layoutModule]);
    expect((await dev?.loadRegistrationLayouts?.())?.[0]).toBe(layoutModule);
    expect((await production?.loadRegistrationLayouts?.())?.[0]).toBe(layoutModule);

    for (const options of [dev, production]) {
      const composed = await options?.loadComposedLayout?.();
      expect(composed?.middleware).toEqual([guard]);
      expect(composed?.metadata).toEqual({ robots: "noindex" });
      expect(composed).not.toBe(layoutModule);
    }
  });

  it("refuses an invalid live root before routes or registration hooks", async () => {
    const appRoot = makeAppTree({ "src/web/dashboard.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const rootFile = path.join(appSrcRoot, "web/root.tsx");
    const pageFile = path.join(appSrcRoot, "web/dashboard.page.tsx");
    const rootRegister = vi.fn();
    const pageRegister = vi.fn();
    const vite = {
      ssrLoadModule: async (id: string) => {
        if (id === rootFile) {
          return { config: { middleware: [42] }, register: rootRegister, default: () => null };
        }
        if (id === pageFile)
          return { config: { route: "/dashboard" }, register: pageRegister, default: () => null };
        throw new Error(`unexpected module ${id}`);
      },
      moduleGraph: undefined,
    } as unknown as InstallPageRoutesOptions["vite"];
    const dev = recordingRouter();

    await expect(
      installPageRoutes({ router: dev.router, vite, appSrcRoot, appFile: rootFile }),
    ).rejects.toThrow(rootFile);

    expect(dev.registered).toEqual([]);
    expect(rootRegister).not.toHaveBeenCalled();
    expect(pageRegister).not.toHaveBeenCalled();
  });

  it("rejects error.page.tsx config.route with the same error class and source file", async () => {
    const appRoot = makeAppTree({
      "src/web/error.page.tsx":
        "export const config = { route: '/error' }; export default () => null;",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const errorPageFile = path.join(appSrcRoot, "web/error.page.tsx");
    const rawErrorPage = pageModule({ route: "/error" });
    const vite = {
      ssrLoadModule: async (id: string) =>
        id === errorPageFile ? rawErrorPage : { config: {}, default: () => null },
      moduleGraph: undefined,
    } as unknown as InstallPageRoutesOptions["vite"];
    const dev = recordingRouter();

    const devError = await installPageRoutes({
      router: dev.router,
      vite,
      appSrcRoot,
      appFile: path.join(appSrcRoot, "web/root.tsx"),
    }).catch((error: unknown) => error);

    let productionError: unknown;
    try {
      installPageRoutesFromManifest({
        router: recordingRouter().router,
        manifest: {
          errorPage: { sourceFile: errorPageFile, module: rawErrorPage },
          pages: [],
        },
        createHandler: () => async () => undefined,
      });
    } catch (error) {
      productionError = error;
    }

    expect(devError).toBeInstanceOf(ErrorPageDeclaresRouteError);
    expect(productionError).toBeInstanceOf(ErrorPageDeclaresRouteError);
    expect((productionError as Error).constructor).toBe((devError as Error).constructor);
    expect((devError as Error).message).toContain(errorPageFile);
    expect((productionError as Error).message).toContain(errorPageFile);
  });

  it.each([
    ["unknown config key", { unknown: true }],
    ["legacy named route export", undefined, { route: "/legacy" }],
    ["withdrawn route.cache", { route: { path: "/bad", cache: { public: true, maxAge: 60 } } }],
  ])(
    "rejects %s with the source file in both installers",
    async (_case, pageConfig, legacy: Record<string, unknown> = {}) => {
      const appRoot = makeAppTree({ "src/web/bad.page.tsx": "" });
      const appSrcRoot = path.join(appRoot, "src");
      const devSource = path.join(appSrcRoot, "web/bad.page.tsx");
      const devRaw = { ...pageModule(pageConfig ?? {}), ...legacy };
      const vite = {
        ssrLoadModule: async (id: string) =>
          id === devSource ? devRaw : { config: {}, default: () => null },
        moduleGraph: undefined,
      } as unknown as InstallPageRoutesOptions["vite"];
      const dev = recordingRouter();
      vi.spyOn(routeHandlerModule, "createPageRouteHandler").mockImplementation(
        () => async () => undefined,
      );

      await expect(
        installPageRoutes({
          router: dev.router,
          vite,
          appSrcRoot,
          appFile: path.join(appSrcRoot, "web/root.tsx"),
        }),
      ).rejects.toThrow(devSource);

      const prodSource = "src/web/bad.page.tsx";
      const production = recordingRouter();
      expect(() =>
        installPageRoutesFromManifest({
          router: production.router,
          manifest: {
            app: { sourceFile: "src/web/root.tsx", module: { config: {}, default: () => null } },
            pages: [{ sourceFile: prodSource, module: devRaw, layouts: [] }],
          },
          createHandler: () => async () => undefined,
        }),
      ).toThrow(prodSource);
    },
  );
});
