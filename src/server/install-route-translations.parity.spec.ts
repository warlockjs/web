import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import config from "@mongez/config";
import type { Router } from "@warlock.js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import type { PageManifest } from "./page-manifest";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-route-translations-"));
  temporaryDirectories.push(root);

  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source, "utf8");
  }

  return root;
}

function router(): Router {
  const value = {
    get: vi.fn(() => value),
    withSourceFile: async <T>(_sourceFile: string, callback: () => T | Promise<T>) => callback(),
    list: () => [],
  };

  return value as unknown as Router;
}

function captureDevHandlers(): PageRouteHandlerOptions[] {
  const captured: PageRouteHandlerOptions[] = [];
  vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation((options) => {
    captured.push(options);
    return (async () => undefined) as PageRouteHandler;
  });
  return captured;
}

function fakeVite(modules: Record<string, unknown>): InstallPageRoutesOptions["vite"] {
  return {
    ssrLoadModule: vi.fn(async (sourceFile: string) => {
      const module = modules[sourceFile];
      if (module === undefined) throw new Error(`No fake Vite module for ${sourceFile}.`);
      return module;
    }),
  } as unknown as InstallPageRoutesOptions["vite"];
}

function captureProductionHandlers(): {
  createHandler: NonNullable<InstallPageRoutesFromManifestOptions["createHandler"]>;
  captured: PageRouteHandlerOptions[];
} {
  const captured: PageRouteHandlerOptions[] = [];
  return {
    createHandler: (options) => {
      captured.push(options);
      return (async () => undefined) as PageRouteHandler;
    },
    captured,
  };
}

function webRelative(sourceFile: string): string {
  const source = sourceFile.replaceAll("\\", "/");
  const marker = "src/web/";
  const position = source.indexOf(marker);
  return position < 0 ? source : source.slice(position);
}

function snapshotsByPage(options: readonly PageRouteHandlerOptions[], locale: string) {
  return Object.fromEntries(
    options.map((option) => {
      const snapshot = option.getRouteTranslations?.(option.pageFile, locale);
      return [
        webRelative(option.pageFile),
        snapshot === undefined
          ? undefined
          : { locale: snapshot.locale, keywords: snapshot.keywords },
      ];
    }),
  );
}

function sourceSnapshots(
  options: readonly PageRouteHandlerOptions[],
  locale: string,
  sourceOf: (option: PageRouteHandlerOptions) => string | undefined,
) {
  return Object.fromEntries(
    options.map((option) => {
      const sourceFile = sourceOf(option);
      const snapshot =
        sourceFile === undefined ? undefined : option.getRouteTranslations?.(sourceFile, locale);
      return [
        webRelative(option.pageFile),
        snapshot === undefined
          ? undefined
          : { locale: snapshot.locale, keywords: snapshot.keywords },
      ];
    }),
  );
}

beforeEach(() => {
  config.set("web", {});
  config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("route-locales installer parity", () => {
  it("projects the same root and nested $group snapshot for ordinary and 404 handlers", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": "",
      "src/web/locales.json": '{"site":{"title":{"en":"Site","ar":"الموقع"}}}',
      "src/web/account/locales.json": '{"$group":"profile","copy":{"en":"Account","ar":"الحساب"}}',
      "src/web/account/settings.page.tsx": "",
      "src/web/404.page.tsx": "",
      "src/web/error.page.tsx": "export default function ErrorPage() { return null; }",
    });
    const srcRoot = path.join(appRoot, "src");
    const webRoot = path.join(srcRoot, "web");
    const rootFile = path.join(webRoot, "root.tsx");
    const pageFile = path.join(webRoot, "account", "settings.page.tsx");
    const notFoundFile = path.join(webRoot, "404.page.tsx");
    const errorPageFile = path.join(webRoot, "error.page.tsx");
    const devHandlers = captureDevHandlers();

    await installPageRoutes({
      router: router(),
      vite: fakeVite({
        [rootFile]: { default: (): null => null },
        [pageFile]: { default: (): null => null, config: { route: "/account/settings" } },
        [notFoundFile]: { default: (): null => null },
        [errorPageFile]: { default: (): null => null },
      }),
      appSrcRoot: srcRoot,
      appFile: rootFile,
    });

    const { createHandler, captured: productionHandlers } = captureProductionHandlers();
    const productionRead = vi.spyOn(fs, "readFileSync");
    const manifest: PageManifest = {
      app: { module: { default: (): null => null }, sourceFile: "src/web/root.tsx" },
      errorPage: { module: { default: (): null => null }, sourceFile: "src/web/error.page.tsx" },
      pages: [
        {
          module: { default: (): null => null, config: { route: "/account/settings" } },
          sourceFile: "src/web/account/settings.page.tsx",
          layouts: [],
        },
        { module: { default: (): null => null }, sourceFile: "src/web/404.page.tsx", layouts: [] },
      ],
      localeFiles: [
        {
          sourceFile: "src/web/locales.json",
          webRoot: "src/web",
          source: '{"site":{"title":{"en":"Site","ar":"الموقع"}}}',
        },
        {
          sourceFile: "src/web/account/locales.json",
          webRoot: "src/web",
          source: '{"$group":"profile","copy":{"en":"Account","ar":"الحساب"}}',
        },
      ],
    };

    installPageRoutesFromManifest({ router: router(), manifest, createHandler });

    expect(productionRead).not.toHaveBeenCalled();
    expect(snapshotsByPage(devHandlers, "ar")).toEqual({
      "src/web/account/settings.page.tsx": {
        locale: "ar",
        keywords: { site: { title: "الموقع" }, profile: { copy: "الحساب" } },
      },
      "src/web/404.page.tsx": { locale: "ar", keywords: { site: { title: "الموقع" } } },
    });
    expect(snapshotsByPage(productionHandlers, "ar")).toEqual(snapshotsByPage(devHandlers, "ar"));
    expect(sourceSnapshots(productionHandlers, "ar", (option) => option.appFile)).toEqual(
      sourceSnapshots(devHandlers, "ar", (option) => option.appFile),
    );
    expect(sourceSnapshots(devHandlers, "ar", (option) => option.appFile)).toEqual({
      "src/web/account/settings.page.tsx": {
        locale: "ar",
        keywords: { site: { title: "الموقع" } },
      },
      "src/web/404.page.tsx": { locale: "ar", keywords: { site: { title: "الموقع" } } },
    });
    expect(sourceSnapshots(productionHandlers, "ar", (option) => option.errorPageFile)).toEqual(
      sourceSnapshots(devHandlers, "ar", (option) => option.errorPageFile),
    );
    expect(sourceSnapshots(devHandlers, "ar", (option) => option.errorPageFile)).toEqual({
      "src/web/account/settings.page.tsx": {
        locale: "ar",
        keywords: { site: { title: "الموقع" } },
      },
      "src/web/404.page.tsx": { locale: "ar", keywords: { site: { title: "الموقع" } } },
    });
  });

  it("refuses invalid configured locales from a production artifact even when no pages exist", () => {
    config.set("app", { localeCodes: [], localeCode: "en" });
    const manifest: PageManifest = {
      pages: [],
      localeFiles: [
        {
          sourceFile: "src/web/locales.json",
          webRoot: "src/web",
          source: '{"site":{"title":{"en":"Site"}}}',
        },
      ],
    };

    expect(() => installPageRoutesFromManifest({ router: router(), manifest })).toThrow(
      /localeCodes/u,
    );
  });

  it("leaves handlers in legacy mode when the manifest has no locale JSON", () => {
    const { createHandler, captured } = captureProductionHandlers();
    const manifest: PageManifest = {
      app: { module: { default: (): null => null }, sourceFile: "src/web/root.tsx" },
      pages: [
        {
          module: { default: (): null => null, config: { route: "/" } },
          sourceFile: "src/web/home.page.tsx",
          layouts: [],
        },
      ],
    };

    installPageRoutesFromManifest({ router: router(), manifest, createHandler });

    expect(captured[0]?.getRouteTranslations).toBeUndefined();
  });
});
