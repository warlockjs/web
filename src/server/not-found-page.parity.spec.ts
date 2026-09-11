import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import { NOT_FOUND_ROUTE_PATH } from "./not-found-page";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";

type RegisteredRoute = {
  path: string;
  options: { name?: string; isPage?: boolean };
};

type NotFoundOutput = {
  routes: RegisteredRoute[];
  handler:
    | {
        layoutFile: string | undefined;
        matchedPath: string | undefined;
        skipPageLoader: boolean | undefined;
        statusForRenderedOk: number | undefined;
      }
    | undefined;
};

type Fixture = {
  files: Record<string, string>;
  manifestPages: PageManifestPageEntry[];
  modules: Record<string, unknown>;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  vi.restoreAllMocks();
});

function materialize(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-not-found-parity-"));
  temporaryDirectories.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }

  return root;
}

function recordingRouter() {
  const routes: RegisteredRoute[] = [];

  const router = {
    get(path: string, _handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      routes.push({ path, options });
      return router;
    },
    async withSourceFile<T>(_sourceFile: string, callback: () => T | Promise<T>) {
      return callback();
    },
    removeRoutesBySourceFile() {},
    list: () => routes.map((route) => ({ path: route.path, isPage: route.options.isPage })),
  } as unknown as Router;

  return { router, routes };
}

function outputOf(
  routes: RegisteredRoute[],
  handlers: readonly PageRouteHandlerOptions[],
): NotFoundOutput {
  const handler = handlers.find((candidate) => candidate.path === NOT_FOUND_ROUTE_PATH);

  return {
    routes: routes.filter((route) => route.path === NOT_FOUND_ROUTE_PATH),
    handler:
      handler === undefined
        ? undefined
        : {
            layoutFile: handler.layoutFile,
            matchedPath: handler.matchPath?.("/parity-miss"),
            skipPageLoader: handler.skipPageLoader,
            statusForRenderedOk: handler.statusForRenderedOk,
          },
  };
}

async function installThroughDev(fixture: Fixture, appRoot: string): Promise<NotFoundOutput> {
  const appSrcRoot = path.join(appRoot, "src");
  const handlers: PageRouteHandlerOptions[] = [];
  const { router, routes } = recordingRouter();

  vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation((options) => {
    handlers.push(options);
    return async () => undefined;
  });

  const vite = {
    ssrLoadModule: async (file: string) => fixture.modules[file],
  } as InstallPageRoutesOptions["vite"];

  await installPageRoutes({
    router,
    vite,
    appSrcRoot,
    appFile: path.join(appSrcRoot, "web/root.tsx"),
  });

  return outputOf(routes, handlers);
}

function installThroughProduction(fixture: Fixture): NotFoundOutput {
  const handlers: PageRouteHandlerOptions[] = [];
  const { router, routes } = recordingRouter();
  const manifest: PageManifest = {
    app: { module: { default: () => null }, sourceFile: "src/web/root.tsx" },
    pages: fixture.manifestPages,
  };

  installPageRoutesFromManifest({
    router: router as InstallPageRoutesFromManifestOptions["router"],
    manifest,
    createHandler: (options) => {
      handlers.push(options);
      return async () => undefined;
    },
  });

  return outputOf(routes, handlers);
}

function fixture({ page, notFound }: { page: boolean; notFound: boolean }): Fixture {
  const files: Record<string, string> = { "src/web/root.tsx": "" };
  const manifestPages: PageManifestPageEntry[] = [];
  const modules: Record<string, unknown> = {};

  if (page) {
    files["src/web/home.page.tsx"] = "";
    manifestPages.push({
      module: { default: () => null, route: "/" },
      sourceFile: "src/web/home.page.tsx",
      layouts: [],
    });
  }

  if (notFound) {
    files["src/web/404.page.tsx"] = "";
    manifestPages.push({
      module: { default: () => null },
      sourceFile: "src/web/404.page.tsx",
      layouts: [],
    });
  }

  return { files, manifestPages, modules };
}

describe("not-found route parity gate", () => {
  it.each([
    ["a page with the framework fallback", { page: true, notFound: false }],
    ["a page with a custom 404", { page: true, notFound: true }],
    ["only a custom 404", { page: false, notFound: true }],
    ["no page surface", { page: false, notFound: false }],
  ])("diffs dev and production outputs for %s", async (_label, shape) => {
    const subject = fixture(shape);
    const appRoot = materialize(subject.files);
    const appSrcRoot = path.join(appRoot, "src");

    for (const relative of Object.keys(subject.files)) {
      subject.modules[path.join(appRoot, relative)] = relative.endsWith("home.page.tsx")
        ? { default: () => null, route: "/" }
        : { default: () => null };
    }

    // Reuse the materialized fixture for both sides; production reads its manifest
    // while development discovers and loads the identical source tree.
    const dev = await installThroughDev(subject, appRoot);
    const production = installThroughProduction(subject);

    expect(dev).toEqual(production);
  });
});
