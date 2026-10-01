import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import config from "@mongez/config";
import { Router, container } from "@warlock.js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import { createSiteDispatch } from "./site-dispatch";
import type { SitesConfig } from "../sites/site-config.types";

const temporaryDirectories: string[] = [];
const router = Router.getInstance();

function makeAppTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-multi-site-translations-"));
  temporaryDirectories.push(root);

  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source, "utf8");
  }

  return root;
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

beforeEach(() => {
  config.set("web", {});
  config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
  container.set("http.server", { addHook: vi.fn() } as never);
});

afterEach(() => {
  for (const route of router.list()) {
    if (route.sourceFile !== undefined) router.removeRoutesBySourceFile(route.sourceFile);
  }

  container.delete("http.server");
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("dev installPageRoutes: multi-site route translations", () => {
  it("hands the site root and its pages the same non-empty dictionary production resolves", async () => {
    const appRoot = makeAppTree({
      "src/web/$sites/main/root.tsx": "export default function Root() { return null; }",
      "src/web/$sites/main/index.page.tsx": "export default function Page() { return null; }",
      "src/web/$sites/main/account/settings.page.tsx":
        "export default function Page() { return null; }",
      "src/web/$sites/main/locales.json": '{"site":{"title":{"en":"Site","ar":"الموقع"}}}',
      "src/web/$sites/main/account/locales.json":
        '{"$group":"profile","copy":{"en":"Account","ar":"الحساب"}}',
    });
    const srcRoot = path.join(appRoot, "src");
    const siteRoot = path.join(srcRoot, "web", "$sites", "main");
    const rootFile = path.join(siteRoot, "root.tsx");
    const indexFile = path.join(siteRoot, "index.page.tsx");
    const settingsFile = path.join(siteRoot, "account", "settings.page.tsx");
    const sites: SitesConfig = { main: { hosts: ["main.test"] } };
    const handlers = captureDevHandlers();

    await installPageRoutes({
      router,
      vite: fakeVite({
        [rootFile]: { default: (): null => null },
        [indexFile]: { default: (): null => null, config: { route: "/" } },
        [settingsFile]: { default: (): null => null, config: { route: "/account/settings" } },
      }),
      appRoot,
      appSrcRoot: srcRoot,
      appFile: path.join(srcRoot, "web", "root.tsx"),
      siteDispatch: { dispatch: createSiteDispatch({ sites }), sites },
    });

    const index = handlers.find((handler) => handler.pageFile === indexFile);
    const settings = handlers.find((handler) => handler.pageFile === settingsFile);

    expect(index).toBeDefined();
    expect(settings).toBeDefined();

    // The root dictionary: the translations handed to the root's LocaleProvider
    // (and the hydration payload / client rebuild) come from this lookup.
    expect(index!.getRouteTranslations?.(index!.appFile, "ar").keywords).toEqual({
      site: { title: "الموقع" },
    });
    expect(settings!.getRouteTranslations?.(settings!.appFile, "ar").keywords).toEqual({
      site: { title: "الموقع" },
    });

    // A page additionally sees the locale files between it and the site root,
    // keyed relative to the site root exactly as production keys them.
    expect(settings!.getRouteTranslations?.(settingsFile, "en").keywords).toEqual({
      site: { title: "Site" },
      profile: { copy: "Account" },
    });
  });
});
