import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { router } from "@warlock.js/core";
import type { ViteDevServer } from "vite";
import type { InstalledPageRoute } from "./install-page-routes";
import { FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE } from "./install-page-routes";
import { WebConnector } from "./web-connector";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  const ssrLoadModule = vi.fn(async () =>
    typeof pageModule === "function" ? pageModule() : pageModule,
  );
  const registryNode = { id: "\0virtual:warlock/pages" };
  const getModuleById = vi.fn(() => registryNode);
  const invalidateModule = vi.fn();
  const send = vi.fn();
  const vite = {
    environments: {
      ssr: { moduleGraph: { onFileChange } },
      client: { moduleGraph: { getModuleById, invalidateModule } },
    },
    ssrLoadModule,
    hot: { send },
  } as unknown as ViteDevServer;

  return { vite, onFileChange, ssrLoadModule, registryNode, getModuleById, invalidateModule, send };
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
      const vite = fakeVite({ route: "/settings" });
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
    const vite = fakeVite({ route: { path: "/settings" } });
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
  });

  it("atomically replaces routes, then invalidates the client registry for a route edit", async () => {
    const files = fixture();
    const vite = fakeVite({ route: { path: "/profile", name: "profile" } });
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
    const vite = fakeVite(() => ({ route: currentRoute }));
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
    const vite = fakeVite(() => ({ route: currentRoute }));
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
    const vite = fakeVite({ route: "/profile" });
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
});
