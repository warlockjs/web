import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { router, setConfig } from "@warlock.js/core";
import type { ViteDevServer } from "vite";
import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import type { InstalledPageRoute } from "./install-page-routes";
import {
  FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE,
  installPageRoutes,
  type InstallPageRoutesOptions,
} from "./install-page-routes";

const sitemapMocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
}));

vi.mock("../sitemap/sitemap-lifecycle", () => ({
  refreshSitemapModelSubscriptions: sitemapMocks.refresh,
  shutdownSitemapRuntime: vi.fn(async () => undefined),
}));

import { WebConnector } from "./web-connector";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  sitemapMocks.refresh.mockClear();
  setConfig("app", {});
  setConfig("web", {});
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function fixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-live-pages-"));
  temporaryDirectories.push(appRoot);
  const appSrcRoot = path.join(appRoot, "src");
  const pageFile = path.join(appSrcRoot, "web", "settings.page.tsx");
  fs.mkdirSync(path.dirname(pageFile), { recursive: true });
  fs.writeFileSync(pageFile, "export const route = '/settings';");

  return { appRoot, appSrcRoot, pageFile };
}

function page(file: string, overrides: Partial<InstalledPageRoute> = {}): InstalledPageRoute {
  return {
    declaredPath: "/settings",
    path: "/admin/settings",
    name: "settings",
    file,
    layoutFile: undefined,
    ...overrides,
  };
}

function fakeVite(pageModule: unknown | (() => unknown)) {
  const onFileChange = vi.fn();
  const ssrLoadModule = vi.fn(async (_sourceFile?: string) =>
    typeof pageModule === "function" ? pageModule() : pageModule,
  );
  const registryNode = { id: "\0virtual:warlock/pages" };
  const getModuleById = vi.fn(() => registryNode);
  const invalidateModule = vi.fn();
  const send = vi.fn();
  const vite = {
    moduleGraph: {
      getModulesByFile: () => undefined,
      fileToModulesMap: new Map(),
    },
    environments: {
      ssr: { moduleGraph: { onFileChange } },
      client: { moduleGraph: { getModuleById, invalidateModule } },
    },
    ssrLoadModule,
    hot: { send },
  } as unknown as ViteDevServer;

  return { vite, onFileChange, ssrLoadModule, registryNode, getModuleById, invalidateModule, send };
}

function installerRouter(): InstallPageRoutesOptions["router"] {
  const value = {
    get: vi.fn(() => value),
    withSourceFile: async <T>(_sourceFile: string, callback: () => T | Promise<T>) => callback(),
    removeRoutesBySourceFile: vi.fn(),
  };

  return value as unknown as InstallPageRoutesOptions["router"];
}

function routeLocaleFixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-live-route-locales-"));
  temporaryDirectories.push(appRoot);
  const appSrcRoot = path.join(appRoot, "src");
  const webRoot = path.join(appSrcRoot, "web");
  const appFile = path.join(webRoot, "root.tsx");
  const pageFile = path.join(webRoot, "settings.page.tsx");
  const localeFile = path.join(webRoot, "locales.json");

  fs.mkdirSync(webRoot, { recursive: true });
  fs.writeFileSync(appFile, "export default function Root() { return null; }", "utf8");
  fs.writeFileSync(
    pageFile,
    "export const config = { route: '/settings' };\nexport default function Settings() { return null; }",
    "utf8",
  );

  return { appRoot, appSrcRoot, appFile, pageFile, localeFile };
}

class LiveRoutingConnector extends WebConnector {
  public seed(options: {
    appRoot: string;
    appSrcRoot: string;
    vite: ViteDevServer;
    installedPages: InstalledPageRoute[];
    install: () => Promise<InstalledPageRoute[]>;
  }): void {
    this.resolvedPaths = {
      appRoot: options.appRoot,
      appSrcRoot: options.appSrcRoot,
    } as NonNullable<typeof this.resolvedPaths>;
    this.vite = options.vite;
    this.installedPages = options.installedPages;
    this.installDevPageRoutes = options.install;
  }

  public hotUpdate(file: string): Promise<boolean> {
    return this.handlePageHotUpdate(file);
  }

  public suppressionCount(): number {
    return this.pendingHotUpdateSuppressions.size;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });

  return { promise, resolve };
}

describe("WebConnector live page routing", () => {
  it.each(["added", "removed"] as const)(
    "publishes an %s page set without restarting Vite",
    async (change) => {
      const files = fixture();
      const vite = fakeVite({ config: { route: "/settings" }, default: (): null => null });
      const oldPages = change === "removed" ? [page(files.pageFile)] : [];
      const nextPages = change === "added" ? [page(files.pageFile)] : [];
      const install = vi.fn(async () => nextPages);
      const connector = new LiveRoutingConnector();

      if (change === "removed") fs.rmSync(files.pageFile);

      connector.seed({ ...files, vite: vite.vite, installedPages: oldPages, install });
      vi.spyOn(router, "list").mockReturnValue(
        change === "removed"
          ? ([
              { isPage: true, sourceFile: "src/web/settings.page.tsx" },
              { isPage: true, sourceFile: FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE },
            ] as ReturnType<typeof router.list>)
          : ([] as ReturnType<typeof router.list>),
      );
      const replace = vi
        .spyOn(router, "replaceRoutesBySourceFiles")
        .mockImplementation(async (_owners, callback) => callback());

      expect(connector.shouldRestart([files.pageFile])).toBe(true);
      await connector.restart();

      expect(replace).toHaveBeenCalledTimes(1);
      expect(connector.getInstalledPages()).toEqual(nextPages);
      expect(vite.ssrLoadModule).not.toHaveBeenCalled();
      expect(vite.send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["changed", "layout.tsx", false, "/admin/settings", "/console/settings"],
    ["added", "nested/admin.layout.ts", false, "/admin/settings", "/console/settings"],
    ["deleted", "nested/admin.layout.tsx", true, "/console/settings", "/admin/settings"],
  ] as const)(
    "re-derives descendant routes when a nested layout is %s",
    async (_event, layoutRelative, deleteBeforeUpdate, previousPath, nextPath) => {
      const files = fixture();
      const layoutFile = path.join(files.appSrcRoot, "web", layoutRelative);
      fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
      fs.writeFileSync(layoutFile, "export const prefix = '/console';");
      const vite = fakeVite({});
      const oldPages = [page(files.pageFile, { path: previousPath })];
      const nextPages = [page(files.pageFile, { path: nextPath })];
      const install = vi.fn(async () => nextPages);
      const connector = new LiveRoutingConnector();

      if (deleteBeforeUpdate) fs.rmSync(layoutFile);

      connector.seed({ ...files, vite: vite.vite, installedPages: oldPages, install });
      vi.spyOn(router, "list").mockReturnValue([
        { isPage: true, sourceFile: "src/web/settings.page.tsx" },
        { isPage: true, sourceFile: FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE },
      ] as ReturnType<typeof router.list>);
      const replace = vi
        .spyOn(router, "replaceRoutesBySourceFiles")
        .mockImplementation(async (_owners, callback) => callback());

      expect(connector.shouldRestart([layoutFile])).toBe(true);
      await connector.restart();

      expect(replace).toHaveBeenCalledWith(
        ["src/web/settings.page.tsx", FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE],
        install,
      );
      expect(connector.getInstalledPages()).toEqual(nextPages);
      expect(vite.ssrLoadModule).not.toHaveBeenCalled();
      expect(vite.invalidateModule).toHaveBeenCalledWith(vite.registryNode);
      expect(vite.send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
    },
  );

  it("leaves a component-only page edit to HMR", async () => {
    const files = fixture();
    const vite = fakeVite({ config: { route: { path: "/settings" } }, default: (): null => null });
    const install = vi.fn(async () => [page(files.pageFile)]);
    const connector = new LiveRoutingConnector();

    connector.seed({ ...files, vite: vite.vite, installedPages: [page(files.pageFile)], install });
    vi.spyOn(router, "list").mockReturnValue([
      { isPage: true, sourceFile: "src/web/settings.page.tsx" },
    ] as ReturnType<typeof router.list>);
    const replace = vi.spyOn(router, "replaceRoutesBySourceFiles");

    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    await connector.restart();

    expect(vite.onFileChange).toHaveBeenCalledWith(files.pageFile);
    expect(vite.ssrLoadModule).toHaveBeenCalledWith(files.pageFile);
    expect(replace).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(vite.send).not.toHaveBeenCalled();
    expect(sitemapMocks.refresh).toHaveBeenCalledWith({ appRoot: files.appRoot });
  });

  it("atomically replaces routes, then invalidates the client registry for a route edit", async () => {
    const files = fixture();
    const vite = fakeVite({ config: { route: { path: "/profile", name: "profile" } }, default: (): null => null });
    const next = page(files.pageFile, {
      declaredPath: "/profile",
      path: "/admin/profile",
      name: "profile",
    });
    const install = vi.fn(async () => [next]);
    const connector = new LiveRoutingConnector();

    connector.seed({ ...files, vite: vite.vite, installedPages: [page(files.pageFile)], install });
    vi.spyOn(router, "list").mockReturnValue([
      { isPage: true, sourceFile: "src/web/settings.page.tsx" },
      { isPage: true, sourceFile: FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE },
    ] as ReturnType<typeof router.list>);
    const replace = vi
      .spyOn(router, "replaceRoutesBySourceFiles")
      .mockImplementation(async (_owners, callback) => callback());

    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    await connector.restart();

    expect(replace).toHaveBeenCalledWith(
      ["src/web/settings.page.tsx", FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE],
      install,
    );
    expect(connector.getInstalledPages()).toEqual([next]);
    expect(vite.invalidateModule).toHaveBeenCalledWith(vite.registryNode);
    expect(vite.send).toHaveBeenCalledTimes(1);
    expect(vite.send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
    expect(sitemapMocks.refresh).toHaveBeenCalledWith({ appRoot: files.appRoot });

    // Vite observing the same filesystem event after core consumes exactly one
    // suppression and does not install or reload a second time.
    vite.send.mockClear();
    await expect(connector.hotUpdate(files.pageFile)).resolves.toBe(true);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(vite.send).not.toHaveBeenCalled();
  });

  it("deduplicates a Vite event queued while the core transaction is committing", async () => {
    const files = fixture();
    let currentRoute = { path: "/profile", name: "profile" };
    fs.writeFileSync(files.pageFile, "export const route = '/profile';");
    const vite = fakeVite(() => ({ config: { route: currentRoute }, default: (): null => null }));
    const install = vi.fn(async () => [
      page(files.pageFile, {
        declaredPath: currentRoute.path,
        path: `/admin${currentRoute.path}`,
        name: currentRoute.name,
      }),
    ]);
    const connector = new LiveRoutingConnector();
    const transactionStarted = deferred();
    const releaseTransaction = deferred();

    connector.seed({ ...files, vite: vite.vite, installedPages: [], install });
    vi.spyOn(router, "list").mockReturnValue([] as ReturnType<typeof router.list>);
    const replace = vi
      .spyOn(router, "replaceRoutesBySourceFiles")
      .mockImplementation(async (_owners, callback) => {
        transactionStarted.resolve();
        await releaseTransaction.promise;
        return callback();
      });

    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    const coreUpdate = connector.restart();
    await transactionStarted.promise;
    const viteUpdate = connector.hotUpdate(files.pageFile);
    releaseTransaction.resolve();
    await Promise.all([coreUpdate, viteUpdate]);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(vite.send).toHaveBeenCalledTimes(1);
    expect(connector.suppressionCount()).toBe(0);

    currentRoute = { path: "/account", name: "account" };
    fs.writeFileSync(files.pageFile, "export const route = '/account';");
    await expect(connector.hotUpdate(files.pageFile)).resolves.toBe(true);
    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    await connector.restart();

    expect(replace).toHaveBeenCalledTimes(2);
    expect(vite.send).toHaveBeenCalledTimes(2);
    expect(connector.suppressionCount()).toBe(0);
  });

  it("serializes a core event behind an in-flight Vite transaction without a duplicate", async () => {
    const files = fixture();
    let currentRoute = { path: "/profile", name: "profile" };
    fs.writeFileSync(files.pageFile, "export const route = '/profile';");
    const vite = fakeVite(() => ({ config: { route: currentRoute }, default: (): null => null }));
    const install = vi.fn(async () => [
      page(files.pageFile, {
        declaredPath: currentRoute.path,
        path: `/admin${currentRoute.path}`,
        name: currentRoute.name,
      }),
    ]);
    const connector = new LiveRoutingConnector();
    const transactionStarted = deferred();
    const releaseTransaction = deferred();

    connector.seed({ ...files, vite: vite.vite, installedPages: [], install });
    vi.spyOn(router, "list").mockReturnValue([] as ReturnType<typeof router.list>);
    const replace = vi
      .spyOn(router, "replaceRoutesBySourceFiles")
      .mockImplementation(async (_owners, callback) => {
        transactionStarted.resolve();
        await releaseTransaction.promise;
        return callback();
      });

    const viteUpdate = connector.hotUpdate(files.pageFile);
    await transactionStarted.promise;
    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    const coreUpdate = connector.restart();
    releaseTransaction.resolve();
    await Promise.all([viteUpdate, coreUpdate]);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(vite.send).toHaveBeenCalledTimes(1);
    expect(connector.suppressionCount()).toBe(0);

    currentRoute = { path: "/account", name: "account" };
    fs.writeFileSync(files.pageFile, "export const route = '/account';");
    await expect(connector.hotUpdate(files.pageFile)).resolves.toBe(true);
    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    await connector.restart();

    expect(replace).toHaveBeenCalledTimes(2);
    expect(vite.send).toHaveBeenCalledTimes(2);
    expect(connector.suppressionCount()).toBe(0);
  });

  it("keeps installed state and sends no reload when the staged install rejects", async () => {
    const files = fixture();
    const old = page(files.pageFile);
    const vite = fakeVite({ config: { route: "/profile" }, default: (): null => null });
    const failure = new Error("duplicate page path");
    const install = vi.fn(async () => {
      throw failure;
    });
    const connector = new LiveRoutingConnector();

    connector.seed({ ...files, vite: vite.vite, installedPages: [old], install });
    vi.spyOn(router, "list").mockReturnValue([
      { isPage: true, sourceFile: "src/web/settings.page.tsx" },
    ] as ReturnType<typeof router.list>);
    vi.spyOn(router, "replaceRoutesBySourceFiles").mockImplementation(async (_owners, callback) =>
      callback(),
    );

    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    await expect(connector.restart()).rejects.toBe(failure);

    expect(connector.getInstalledPages()).toEqual([old]);
    expect(vite.getModuleById).not.toHaveBeenCalled();
    expect(vite.invalidateModule).not.toHaveBeenCalled();
    expect(vite.send).not.toHaveBeenCalled();
  });

  it("atomically publishes locale JSON additions, edits, and removals while retaining the last table on invalid JSON", async () => {
    const files = routeLocaleFixture();
    const capturedHandlers: PageRouteHandlerOptions[] = [];
    const vite = fakeVite({});
    const modules: Record<string, unknown> = {
      [files.appFile]: { default: (): null => null },
      [files.pageFile]: { config: { route: "/settings" }, default: (): null => null },
    };
    vite.ssrLoadModule.mockImplementation(async (sourceFile?: string) => {
      const module = modules[sourceFile as keyof typeof modules];
      if (module === undefined) throw new Error(`No Vite module for ${sourceFile}.`);
      return module;
    });
    vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
      (options) => {
        capturedHandlers.push(options);
        return (async () => undefined) as PageRouteHandler;
      },
    );
    setConfig("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    setConfig("web", {});

    const artifactPath = path.join(files.appRoot, ".warlock", "route-locales.manifest.json");
    const artifactSource = () => fs.readFileSync(artifactPath, "utf8");
    const install = () =>
      installPageRoutes({
        router: installerRouter(),
        vite: vite.vite,
        appSrcRoot: files.appSrcRoot,
        appFile: files.appFile,
        routeLocaleArtifactPath: artifactPath,
      });
    const initialPages = await install();
    const connector = new LiveRoutingConnector();
    let committedPages: unknown = initialPages;
    connector.seed({ ...files, vite: vite.vite, installedPages: initialPages, install });
    vi.spyOn(router, "list").mockReturnValue([
      { isPage: true, sourceFile: "src/web/settings.page.tsx" },
      { isPage: true, sourceFile: FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE },
    ] as ReturnType<typeof router.list>);
    vi.spyOn(router, "replaceRoutesBySourceFiles").mockImplementation(async (_owners, callback) => {
      const stagedPages = await callback();
      committedPages = stagedPages;
      return stagedPages;
    });

    const latestKeywords = () =>
      [...capturedHandlers]
        .reverse()
        .find((options) => options.pageFile === files.pageFile)
        ?.getRouteTranslations?.(files.pageFile, "en")?.keywords;

    expect(latestKeywords()).toBeUndefined();
    expect(JSON.parse(artifactSource()).localeFiles).toEqual([]);

    fs.writeFileSync(files.localeFile, '{"copy":{"en":"First","ar":"أول"}}', "utf8");
    await expect(connector.hotUpdate(files.localeFile)).resolves.toBe(true);
    expect(latestKeywords()).toEqual({ copy: "First" });
    expect(JSON.parse(artifactSource()).localeFiles[0].source).toContain("First");

    fs.writeFileSync(files.localeFile, '{"copy":{"en":"Second","ar":"ثان"}}', "utf8");
    await expect(connector.hotUpdate(files.localeFile)).resolves.toBe(true);
    expect(latestKeywords()).toEqual({ copy: "Second" });
    const lastUsablePages = connector.getInstalledPages();
    const lastUsableKeywords = latestKeywords();
    const lastUsableArtifact = artifactSource();

    fs.writeFileSync(files.localeFile, '{"copy":{"en":"Broken"}', "utf8");
    await expect(connector.hotUpdate(files.localeFile)).rejects.toThrow(files.localeFile);
    expect(connector.getInstalledPages()).toEqual(lastUsablePages);
    expect(committedPages).toEqual(lastUsablePages);
    expect(latestKeywords()).toEqual(lastUsableKeywords);
    expect(artifactSource()).toBe(lastUsableArtifact);

    // Valid JSON still cannot replace the artifact when later page validation fails.
    fs.writeFileSync(files.localeFile, '{"copy":{"en":"Uncommitted","ar":"Pending"}}', "utf8");
    const notFoundFile = path.join(path.dirname(files.pageFile), "404.page.tsx");
    fs.writeFileSync(notFoundFile, "export default function NotFound() { return null; }", "utf8");
    modules[notFoundFile] = { config: { route: "/invalid-404" }, default: (): null => null };
    await expect(connector.hotUpdate(files.localeFile)).rejects.toThrow();
    expect(connector.getInstalledPages()).toEqual(lastUsablePages);
    expect(artifactSource()).toBe(lastUsableArtifact);
    expect(fs.readdirSync(path.dirname(artifactPath))).toEqual([path.basename(artifactPath)]);
    fs.rmSync(notFoundFile);
    delete modules[notFoundFile];

    fs.rmSync(files.localeFile);
    await expect(connector.hotUpdate(files.localeFile)).resolves.toBe(true);
    expect(latestKeywords()).toBeUndefined();
    expect(JSON.parse(artifactSource()).localeFiles).toEqual([]);
  });
});
