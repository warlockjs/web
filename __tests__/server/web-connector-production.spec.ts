/**
 * `WebConnector` — the PRODUCTION page-serving path.
 *
 * The dev path evaluates page modules inside Vite's SSR graph and discovers
 * them by walking `app/`. A built application has neither: the generated pages
 * barrel already imported every module and handed them over as a
 * `PageManifest`, and `installPageRoutesFromManifest` turns that table into
 * registered routes. This file is about the seam between those two facts — the
 * connector choosing the manifest path, and choosing it WITHOUT reaching for a
 * dependency a production install does not carry.
 *
 * Mocked at exactly two seams:
 *  - `vite`'s `createServer`, so "no Vite was constructed" is an assertion
 *    against a spy rather than an inference from the absence of a crash. The
 *    dev case in this file uses the same spy in the opposite direction.
 *  - `resolveHydrationClientUrl`, because the hydration URL is resolved ONLY
 *    when there are pages to hydrate, and "was not called" cannot be proven
 *    against a resolver that reads the filesystem.
 *
 * Everything else is the production object: the real page-manifest registry
 * filled by a real `providePageManifest`, the real `Application` runtime
 * strategy, the real `installPageRoutesFromManifest`, and the real core router
 * — with only its `get` doubled, so registration is observable and no route
 * leaks into the singleton between cases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import type { PageManifest } from "../../src/server/page-manifest";

const createServerMock = vi.hoisted(() => vi.fn());
const resolveHydrationClientUrlMock = vi.hoisted(() => vi.fn(() => "/assets/hydration-test.js"));

/** Mutable stand-in for the app's `build.outdir`; the connector derives `<outdir>/client` from it. */
const buildOutdir = vi.hoisted(() => ({ current: "" }));

// `importOriginal` rather than a bare factory: `web/src/vite/*` reaches into
// the real `vite` package for its types and helpers, and only `createServer` is
// this spec's seam.
vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();

  return { ...actual, createServer: createServerMock };
});

vi.mock("../../src/server/hydration-client-url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/hydration-client-url")>();

  return { ...actual, resolveHydrationClientUrl: resolveHydrationClientUrlMock };
});

vi.mock("../../../core/src/production/resolve-build-config", () => ({
  resolveBuildConfig: () => ({ outdir: buildOutdir.current }),
}));

/**
 * A real app root whose `app/` directory exists and holds no pages — the dev
 * case walks it eagerly, and a missing directory would fail that case for a
 * reason that has nothing to do with what it claims.
 */
const appSrcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/app-root");

/** The one export `installPageRoutesFromManifest` reads off a page module namespace. */
function pageModule(route: string) {
  return { route, default: () => null };
}

const appEntry = {
  module: { default: () => null },
  sourceFile: "src/web/root.tsx",
};

/** A build that discovered one page under one module, with no layout. */
function manifestWithOnePage(): PageManifest {
  return {
    // What the build bakes in: `<outdir>/client`, read back at boot to locate
    // both the Vite manifest and the asset directory the connector mounts.
    // Derived from `buildOutdir` so it tracks whatever the test set.
    clientDir: path.join(buildOutdir.current, "client"),
    app: appEntry,
    pages: [
      {
        module: pageModule("/products"),
        sourceFile: "src/app/main/web/products.page.tsx",
        layouts: [],
      },
    ],
  };
}

/**
 * A second, pristine copy of the connector and everything it reads at boot.
 *
 * The page-manifest registry is module-level state with a provided-once guard
 * and deliberately no resetter, so a suite that needs several tests to start
 * from "no barrel ran" has to get a fresh instance of the registry rather than
 * reset it. The connector, the container, `Application` and the ROUTER must all
 * come from the same epoch: a connector from an earlier import registers on the
 * earlier router singleton, and a spy installed on this file's copy would never
 * see it.
 *
 * The first case to call this pays a COLD transform of that whole graph (~19-23s
 * idle, dominated by `core/src/http/request` and its aliased `@warlock.js/seal`
 * / `@warlock.js/cascade` sources); later calls are ~200ms, since
 * `vi.resetModules()` clears the module registry and not the transform cache.
 * The budget for it lives on the `web-tests` project (vitest.config.ts) rather
 * than per case here: a per-case timeout OVERRIDES the project's, so a number
 * declared in this file would silently defeat the budget the suite shares.
 */
async function freshWebGraph() {
  vi.resetModules();

  const [registry, connectorModule, containerModule, applicationModule, routerModule] =
    await Promise.all([
      import("../../src/server/page-manifest"),
      import("../../src/server/web-connector"),
      import("../../../core/src/container"),
      import("../../../core/src/application/application"),
      import("../../../core/src/router/router"),
    ]);

  return {
    container: containerModule.container,
    WebConnector: connectorModule.WebConnector,
    WebPageManifestMissingError: connectorModule.WebPageManifestMissingError,
    Application: applicationModule.Application,
    router: routerModule.router,
    providePageManifest: registry.providePageManifest,
  };
}

type WebGraph = Awaited<ReturnType<typeof freshWebGraph>>;

/**
 * Doubles the router's `get` so every registration is recorded and none of them
 * survives into the next case. The real router is a process-wide singleton with
 * a duplicate-name refusal — registering the same page twice across cases would
 * fail for bookkeeping reasons rather than for anything this file is about.
 */
function recordRoutes(graph: WebGraph) {
  const registered: { path: string; name: string | undefined }[] = [];

  vi.spyOn(graph.router, "get").mockImplementation(((
    routePath: string,
    _handler: unknown,
    options?: { name?: string },
  ) => {
    registered.push({ path: routePath, name: options?.name });

    return graph.router;
  }) as Router["get"]);

  return registered;
}

/** The Fastify instance `HttpConnector.boot()` publishes before this connector boots. */
function publishFastify(graph: WebGraph) {
  const fastify = {
    server: { closeAllConnections: vi.fn(), on: vi.fn() },
    addHook: vi.fn(),
    listen: vi.fn(),
  };

  graph.container.set("http.server", fastify as never);

  return fastify;
}

/** The barrel double the dev path receives through `vite.ssrLoadModule`. */
function viteDouble() {
  const webServerModule = {
    connectSharedStore: vi.fn(),
    connectPageContext: vi.fn(),
    installPageRoutes: vi.fn(async () => []),
    devStylesheetUrls: vi.fn(() => [] as string[]),
  };

  const vite = {
    middlewares: vi.fn(),
    ssrLoadModule: vi.fn(async () => webServerModule),
    close: vi.fn(async () => undefined),
  };

  createServerMock.mockResolvedValue(vite);

  return { vite, webServerModule };
}

beforeEach(() => {
  buildOutdir.current = path.join(path.sep, "tmp", "warlock-web-prod-outdir");
  resolveHydrationClientUrlMock.mockClear();
  createServerMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebConnector — production page serving", () => {
  it("registers the manifest's pages and constructs no development server", async () => {
    const graph = await freshWebGraph();
    const manifest = manifestWithOnePage();

    graph.providePageManifest(manifest);
    graph.Application.setRuntimeStrategy("production");
    publishFastify(graph);

    const registered = recordRoutes(graph);
    const connector = new graph.WebConnector({ appSrcRoot });

    await connector.boot();

    // The page's own `route` export decides the URL, in production exactly as
    // in development — a build cannot quietly disagree with the dev server.
    expect(registered).toEqual([
      { path: "/products", name: "main.products" },
      // The catch-all, registered last and belonging to the framework
      // rather than to the application: it answers every URL that no page
      // and no API route claimed, with a 404 status either way.
      { path: "*", name: "warlock.not-found" },
    ]);
    expect(connector.getInstalledPages()).toEqual([
      {
        path: "/products",
        name: "main.products",
        file: "src/app/main/web/products.page.tsx",
        layoutFile: undefined,
      },
    ]);

    // The claim this path exists for: no development server was created. Vite
    // is an optional peer, so reaching for it here is not a slow boot, it is a
    // module resolution failure on the one path meant to contain none.
    expect(createServerMock).not.toHaveBeenCalled();

    // And the hydration URL came from the built client manifest.
    expect(resolveHydrationClientUrlMock).toHaveBeenCalledTimes(1);
    // `resolve`, not `join`: the connector resolves the manifest's `clientDir`
    // against the process cwd, which is what lets the build bake a RELATIVE
    // path (`"dist/client"`) and still have it work from wherever the artifact
    // is started. On Windows that also supplies the drive letter this
    // fixture's rooted-but-driveless `\tmp\...` path lacks.
    expect(resolveHydrationClientUrlMock).toHaveBeenCalledWith({
      clientDir: path.resolve(process.cwd(), path.join(buildOutdir.current, "client")),
    });
  });

  it("boots on an empty page table without resolving a hydration URL", async () => {
    // "Built with web, and it has no pages" is a legal state of a built
    // application. Nothing is registered, and — the part that is easy to get
    // wrong — the client manifest is never read: an app with no pages has no
    // hydration entry to point at, and demanding one would make a page-free
    // build unbootable for a file it had no reason to emit.
    const graph = await freshWebGraph();
    const emptyManifest: PageManifest = { pages: [] };

    graph.providePageManifest(emptyManifest);
    graph.Application.setRuntimeStrategy("production");
    publishFastify(graph);

    const registered = recordRoutes(graph);
    const connector = new graph.WebConnector({ appSrcRoot });

    await connector.boot();

    expect(registered).toEqual([]);
    expect(connector.getInstalledPages()).toEqual([]);
    expect(connector.getPageManifest()).toBe(emptyManifest);
    expect(resolveHydrationClientUrlMock).not.toHaveBeenCalled();
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it("still refuses to boot in production when no page manifest was provided", async () => {
    // Unchanged behaviour, and it has to stay proven now that the path past it
    // does something: a production process that boots without a manifest serves
    // 404s while looking healthy.
    const graph = await freshWebGraph();

    graph.Application.setRuntimeStrategy("production");
    publishFastify(graph);
    recordRoutes(graph);

    const connector = new graph.WebConnector({ appSrcRoot });

    await expect(connector.boot()).rejects.toThrow(graph.WebPageManifestMissingError);
    await expect(connector.boot()).rejects.toThrow(/warlock build/i);
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it("refuses a manifest page whose module declares no route, naming the file", async () => {
    // A valid build cannot produce this — page discovery only emits modules it
    // read a `route` off. A stale or hand-edited artifact can, and the answer
    // must not be a page table that silently shrinks: the operator would see a
    // clean boot log and a 404 on a page that is demonstrably in the bundle.
    const graph = await freshWebGraph();

    graph.providePageManifest({
      app: appEntry,
      pages: [
        {
          module: pageModule("/products"),
          sourceFile: "src/app/main/web/products.page.tsx",
          layouts: [],
        },
        {
          module: { default: () => null },
          sourceFile: "src/app/main/web/orphan.page.tsx",
          layouts: [],
        },
      ],
    });
    graph.Application.setRuntimeStrategy("production");
    publishFastify(graph);

    const registered = recordRoutes(graph);
    const connector = new graph.WebConnector({ appSrcRoot });

    await expect(connector.boot()).rejects.toThrow(/orphan\.page\.tsx/);
    await expect(connector.boot()).rejects.toThrow(/route/i);

    // It refuses BEFORE registering anything: a half-installed page table is a
    // worse outcome than a refused boot, because it serves.
    expect(registered).toEqual([]);
  });
});

describe("WebConnector — development page serving is unchanged", () => {
  it("still takes the development branch and installs its routes through it", async () => {
    const graph = await freshWebGraph();

    // A manifest is present and is deliberately IGNORED: the branch reads the
    // runtime strategy, never the value, so a staging checkout that happens to
    // carry a built manifest still boots the way `warlock dev` boots.
    graph.providePageManifest(manifestWithOnePage());
    graph.Application.setRuntimeStrategy("development");
    publishFastify(graph);

    const registered = recordRoutes(graph);
    const { webServerModule } = viteDouble();
    const connector = new graph.WebConnector({ appSrcRoot });

    await connector.boot();

    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(webServerModule.installPageRoutes).toHaveBeenCalledTimes(1);

    // Development installs through the barrel Vite evaluated, so the manifest
    // path registered nothing of its own.
    expect(registered).toEqual([]);
    expect(resolveHydrationClientUrlMock).not.toHaveBeenCalled();
  });
});
