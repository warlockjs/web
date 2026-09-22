import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Application, router } from "@warlock.js/core";
import { FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE } from "./install-page-routes";
import * as unregisteredPagesModule from "./unregistered-pages";
import type { UnregisteredPageReporter } from "./unregistered-pages";
import { providePageManifest } from "./page-manifest";
import { WebConnector } from "./web-connector";
import { regenerateSitemapOnStartup } from "../sitemap/register-web-http-routes";

// Everything a production `boot()` does BESIDES the dev-only discovery cache
// this file is about — mocked out so the production-mode spec below stays
// scoped to the one question it asks (does the dev discovery cache/walk get
// touched?), the same way `install-page-routes.spec.ts` mocks its own
// unrelated collaborators.
vi.mock("./install-production-page-routes", () => ({
  installProductionPageRoutes: vi.fn(async () => []),
}));
vi.mock("./register-production-public-files", () => ({
  registerProductionPublicFiles: vi.fn(),
}));
vi.mock("../sitemap/register-web-http-routes", () => ({
  registerWebHttpRoutes: vi.fn(async () => undefined),
  regenerateSitemapOnStartup: vi.fn(async () => undefined),
}));

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function fixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-unregistered-cache-"));
  temporaryDirectories.push(appRoot);
  const appSrcRoot = path.join(appRoot, "src");
  const pageFile = path.join(appSrcRoot, "web", "settings.page.tsx");
  fs.mkdirSync(path.dirname(pageFile), { recursive: true });
  fs.writeFileSync(pageFile, "export const route = '/settings';");

  return { appRoot, appSrcRoot, pageFile };
}

class DiscoveryCacheConnector extends WebConnector {
  public seed(options: {
    appRoot: string;
    appSrcRoot: string;
    reporter: UnregisteredPageReporter;
  }): void {
    this.resolvedPaths = {
      appRoot: options.appRoot,
      appSrcRoot: options.appSrcRoot,
    } as NonNullable<typeof this.resolvedPaths>;
    this.vite = {} as NonNullable<typeof this.vite>;
    this.reportUnregisteredPages = options.reporter;
  }
}

function fakeReporter(): UnregisteredPageReporter {
  const reporter = vi.fn() as unknown as UnregisteredPageReporter;
  reporter.invalidateDiscovery = vi.fn();
  return reporter;
}

describe("WebConnector wires the page-file watcher to the 404 discovery cache", () => {
  it("invalidates the cached discovery walk when shouldRestart sees a page file change", () => {
    const files = fixture();
    const reporter = fakeReporter();
    const connector = new DiscoveryCacheConnector();

    connector.seed({ appRoot: files.appRoot, appSrcRoot: files.appSrcRoot, reporter });
    vi.spyOn(router, "list").mockReturnValue([
      { isPage: true, sourceFile: "src/web/settings.page.tsx" },
      { isPage: true, sourceFile: FRAMEWORK_DEFAULT_NOT_FOUND_SOURCE_FILE },
    ] as ReturnType<typeof router.list>);

    expect(connector.shouldRestart([files.pageFile])).toBe(true);
    expect(reporter.invalidateDiscovery).toHaveBeenCalledTimes(1);
  });

  it("leaves the cache alone for a change unrelated to any page file", () => {
    const files = fixture();
    const reporter = fakeReporter();
    const connector = new DiscoveryCacheConnector();

    connector.seed({ appRoot: files.appRoot, appSrcRoot: files.appSrcRoot, reporter });
    vi.spyOn(router, "list").mockReturnValue([] as ReturnType<typeof router.list>);

    const unrelatedFile = path.join(files.appSrcRoot, "shared", "helper.ts");

    expect(connector.shouldRestart([unrelatedFile])).toBe(false);
    expect(reporter.invalidateDiscovery).not.toHaveBeenCalled();
  });
});

class BootObservableConnector extends WebConnector {
  public reporter(): UnregisteredPageReporter | undefined {
    return this.reportUnregisteredPages;
  }
}

describe("WebConnector production boot leaves the dev 404 discovery cache untouched", () => {
  afterEach(() => {
    // `Application.runtimeStrategy` is a module-level static on the real
    // `@warlock.js/core` singleton, shared with every other spec in this
    // process — reset it so a later file in the same run does not inherit
    // "production" from this one.
    Application.setRuntimeStrategy("development");
  });

  it("boots without creating the reporter, wiring an onResponse hook, or touching Fastify", async () => {
    providePageManifest({ pages: [] });
    Application.setRuntimeStrategy("production");

    const createReporter = vi.spyOn(unregisteredPagesModule, "createUnregisteredPageReporter");
    const connector = new BootObservableConnector();
    const regenerate = vi.mocked(regenerateSitemapOnStartup);
    regenerate.mockClear();

    // No `http.server` is ever registered in the container. If production
    // boot took even one step down the dev branch — `resolveFastify()` is
    // the very first thing it calls — this would throw, so a clean resolve
    // is itself proof the dev branch (and its `onResponse` 404 hook) never
    // ran for this request path.
    await expect(connector.boot()).resolves.toBeUndefined();

    expect(createReporter).not.toHaveBeenCalled();
    expect(connector.reporter()).toBeUndefined();
    expect(regenerate).not.toHaveBeenCalled();

    await connector.start();

    expect(regenerate).toHaveBeenCalledOnce();
    expect(regenerate).toHaveBeenCalledWith({ appRoot: process.cwd() });

    await connector.restart();

    expect(regenerate).toHaveBeenCalledOnce();
  });
});
