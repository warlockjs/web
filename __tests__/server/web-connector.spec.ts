import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import type { InlineConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorLifecyclePhase, ConnectorPriority, container, router, type Router, type RuntimeStrategy } from "@warlock.js/core";



import { DEV_TRANSFORM_ERROR_BODY } from "../../src/server/dev-server";
import type { PageManifest } from "../../src/server/page-manifest";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { WEB_CONNECTOR_PRIORITY, WebConnector } from "../../src/server/web-connector";

/**
 * `WebConnector` — the guarantees the Vite-on-Fastify mount rests on.
 *
 * This file replaces `__tests__/server/dev-server.spec.ts`, which was deleted
 * when `startDevServer()` became a connector. That spec was an INTEGRATION
 * test (real Fastify + real Vite + a real OS socket, ~85s) and it proved the
 * mount end-to-end but asserted almost nothing about the mount's *shape* — it
 * could not have caught an `hmr.port` creeping back in, a `listen()` moving
 * into the connector, or the barrel being loaded by a plain `import`. Those
 * are the regressions that actually threaten this seam now that core owns the
 * server, so this spec targets them directly.
 *
 * Mocked at exactly three seams and nowhere else:
 *  - `vite`'s `createServer` (`web-connector.ts:334`), so the config object the
 *    connector builds is capturable and the assertions can be about VALUES.
 *  - the container's `http.server` (`web-connector.ts:287-295`), standing in
 *    for `HttpConnector.boot()`'s publish (`core/src/connectors/http-connector.ts:74`).
 *  - core's `resolveBuildConfig`, which throws outside a loaded
 *    `warlock.config.ts` (`core/src/warlock-config/warlock-config.manager.ts:152`)
 *    and whose only contribution here is `outdir`. Pointing it at a temp
 *    directory is what lets the PRODUCTION hydration read be exercised against
 *    a real manifest file rather than a stubbed resolver.
 * Everything else — the connector, the real `web/src/shared` barrel state, the
 * real `router` singleton, the real manifest registry and the real
 * `resolveHydrationClientUrl` — is the production object.
 */

const createServerMock = vi.hoisted(() => vi.fn());

/** Mutable stand-in for the app's `build.outdir`; set per test. */
const buildOutdir = vi.hoisted(() => ({ current: "" }));

// `importOriginal` rather than a bare factory: `web/src/vite/*` and the test
// runner both reach into the real `vite` package, and only `createServer` is
// this spec's seam.
vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();

  return { ...actual, createServer: createServerMock };
});

vi.mock("../../../core/src/production/resolve-build-config", () => ({
  resolveBuildConfig: () => ({ outdir: buildOutdir.current }),
}));

/**
 * The path the connector derives for the pipeline barrel
 * (`web-connector.ts:314`), computed here independently from THIS file's
 * location so the assertion does not restate the implementation's arithmetic.
 */
const webServerBarrel = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/server/index.ts",
);

/**
 * A real app root whose `app/` directory exists and holds no pages.
 *
 * Not cosmetic. `installPageRoutes` scans `<appSrcRoot>/app` eagerly
 * (`web/src/server/install-page-routes.ts:201`) and throws ENOENT if it is
 * absent, so with the default `process.cwd()` root a connector that loaded the
 * barrel through a plain `import` would blow up on a missing directory —
 * red, but for the wrong reason, and nothing like what happens in a real app.
 * Pointing at a real-but-empty root makes that regression fail the way it
 * actually fails in production: quietly, with the shared store unconnected.
 */
const appSrcRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/app-root",
);

/** Marker value only the doubled `installPageRoutes` can return. */
const INSTALLED_PAGES_MARKER = [
  { path: "/__sentinel__", method: "GET" },
] as unknown as ReturnType<WebConnector["getInstalledPages"]>;

type Harness = Awaited<ReturnType<typeof bootHarness>>;

/**
 * Re-importing the connector and everything it reads at boot (see
 * {@link freshWebGraph}) transforms a cold module graph, and the production
 * cases import the real pipeline barrel on top of that — well past vitest's 5s
 * default. Declared per case rather than for the whole project, so the other
 * suites keep catching genuinely slow tests.
 */
const COLD_GRAPH_TIMEOUT = 30_000;

/**
 * A real client build output — `<outdir>/client/.vite/manifest.json` with a
 * hashed `hydration` entry, exactly the shape the client build emits —
 * standing in as the app's `build.outdir` for the duration of `body`.
 */
async function withClientBuild(body: () => Promise<void>): Promise<void> {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-web-connector-"));
  const clientDir = path.join(outdir, "client", ".vite");

  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(
    path.join(clientDir, "manifest.json"),
    JSON.stringify({
      // The REAL Vite shape: keyed by source path, entry name in `name`.
      "src/hydration/index.ts": {
        name: "hydration",
        file: "assets/hydration-abc123.js",
        isEntry: true,
      },
    }),
  );

  buildOutdir.current = outdir;

  try {
    await body();
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

/** An `outdir` nothing was ever built into — the absence is the point. */
function withoutClientBuild(): void {
  buildOutdir.current = path.join(os.tmpdir(), "warlock-web-connector-does-not-exist");
}

/** The one export the manifest registration step reads off a page module namespace. */
function pageModule(route: string) {
  return { route, default: () => null };
}

const appEntry = {
  module: { default: () => null },
  sourceFile: "src/web/root.tsx",
};

/** A build that discovered one page under one module, with no layout. */
/**
 * The client dir the build would have baked in, derived from the SAME
 * `buildOutdir` `withClientBuild` writes into — so a fixture manifest and the
 * fixture bundle on disk cannot name different directories.
 */
function fixtureClientDir(): string {
  return path.join(buildOutdir.current, "client");
}

function manifestWithOnePage(): PageManifest {
  return {
    clientDir: fixtureClientDir(),
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
 * The production modules a harness boots against.
 *
 * Defaults to this file's own imports. The manifest-mode tests hand it a
 * freshly imported copy instead, for the reason spelled out on
 * {@link freshWebGraph}.
 */
type BootGraph = {
  container: typeof container;
  WebConnector: typeof WebConnector;
};

/** This file's own module instances — what every non-manifest test boots. */
const ownGraph: BootGraph = { container, WebConnector };

/**
 * A second, pristine copy of the connector and everything it reads at boot.
 *
 * The page-manifest registry is MODULE-LEVEL STATE with a provided-once guard
 * and, deliberately, no resetter — a public one would be a way around the very
 * rule the guard enforces. So a suite that needs several tests to start from
 * "no barrel ran" cannot reset the registry; it has to get a fresh instance of
 * it, which is what `vi.resetModules()` plus a dynamic import gives. The
 * registry's own spec isolates itself exactly this way.
 *
 * The connector has to come from the SAME epoch, and so do the container, the
 * ROUTER and `Application`: a connector left over from an earlier import still
 * holds the previous registry, registers pages on the previous router, reads the
 * previous container for `http.server` and reads the previous `Application` for
 * the runtime strategy. Importing them together is what makes "provided" and
 * "not provided" real states of the real module rather than a value handed over
 * by a double — the connector calling a double proves nothing about the branch.
 *
 * The pipeline barrel comes along for the same reason: the production path
 * reaches it through its own `await import`, so the copy this file spies on has
 * to be the copy that epoch's connector will find.
 */
async function freshWebGraph() {
  vi.resetModules();

  const [
    registry,
    connectorModule,
    containerModule,
    applicationModule,
    hydrationModule,
    routerModule,
    webServerModule,
  ] = await Promise.all([
    import("../../src/server/page-manifest"),
    import("../../src/server/web-connector"),
    import("../../../core/src/container"),
    import("../../../core/src/application/application"),
    import("../../src/server/hydration-client-url"),
    import("../../../core/src/router/router"),
    import("../../src/server/index"),
  ]);

  return {
    container: containerModule.container,
    WebConnector: connectorModule.WebConnector,
    WebPageManifestMissingError: connectorModule.WebPageManifestMissingError,
    WebClientManifestMissingError: hydrationModule.WebClientManifestMissingError,
    Application: applicationModule.Application,
    router: routerModule.router,
    webServer: webServerModule,
    providePageManifest: registry.providePageManifest,
    consumePageManifest: registry.consumePageManifest,
  };
}

type WebGraph = Awaited<ReturnType<typeof freshWebGraph>>;

/**
 * Pin the axis the connector actually branches on, on the graph's own
 * `Application`.
 *
 * RUNTIME STRATEGY, not `NODE_ENV`. That is the axis the connector reads, and
 * it is also the only one this suite can pin: `NODE_ENV` is inherited from
 * whatever shell runs the tests, and it really is `production` on at least one
 * dev machine here — a spec keyed to it would pass or fail depending on the
 * operator's shell.
 *
 * No restore, and none needed: the graph — `Application` included — is a private
 * copy that goes out of scope when the test ends, so this file's own modules
 * never see the strategy change.
 */
function withRuntimeStrategy(graph: WebGraph, strategy: RuntimeStrategy): void {
  graph.Application.setRuntimeStrategy(strategy);
}

const inProduction = (graph: WebGraph) => withRuntimeStrategy(graph, "production");
const inDevelopment = (graph: WebGraph) => withRuntimeStrategy(graph, "development");

/**
 * Doubles the graph router's `get` so every production registration is recorded
 * and none of them survives into the next case. The router carries a
 * duplicate-name refusal, and a page registered twice would fail for
 * bookkeeping reasons rather than for anything these cases are about.
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

/**
 * Stand up a booted connector against doubles, recording the teardown call
 * order on a single shared array so `shutdown()` sequencing is observable.
 */
async function bootHarness(
  graph: BootGraph = ownGraph,
  harnessAppSrcRoot = appSrcRoot,
  harnessAppRoot = process.cwd(),
) {
  const order: string[] = [];

  const rawServer = {
    listen: vi.fn(),
    close: vi.fn(),
    closeAllConnections: vi.fn(() => {
      order.push("sockets-closed");
    }),
    on: vi.fn(),
  };

  const fastify = {
    server: rawServer,
    listen: vi.fn(),
    addHook: vi.fn(),
  };

  // The module double that `ssrLoadModule` hands back. Deliberately NOT the
  // real barrel: the whole point of test 8 is that these four functions, and
  // not the real barrel's, are the ones the connector wires.
  const webServerModule = {
    connectSharedStore: vi.fn(),
    connectPageContext: vi.fn(),
    installPageRoutes: vi.fn(async () => INSTALLED_PAGES_MARKER),
    devStylesheetUrls: vi.fn(() => [] as string[]),
  };

  const vite = {
    middlewares: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
    ssrLoadModule: vi.fn(async () => webServerModule),
    close: vi.fn(async () => {
      order.push("vite-closed");
    }),
  };

  createServerMock.mockResolvedValue(vite);
  graph.container.set("http.server", fastify as never);

  const connector = new graph.WebConnector({
    appRoot: harnessAppRoot,
    appSrcRoot: harnessAppSrcRoot,
  });

  await connector.boot();

  return {
    connector,
    fastify,
    rawServer,
    vite,
    webServerModule,
    order,
    viteConfig: createServerMock.mock.calls.at(-1)?.[0] as InlineConfig,
  };
}

/** The `onRequest` hook the connector registered (`web-connector.ts:209`). */
function onRequestHook(harness: Harness) {
  const call = harness.fastify.addHook.mock.calls.find(([event]) => event === "onRequest");

  if (!call) throw new Error("connector registered no onRequest hook");

  return call[1] as (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => void;
}

function onResponseHook(harness: Harness) {
  const call = harness.fastify.addHook.mock.calls.find(([event]) => event === "onResponse");

  if (!call) throw new Error("connector registered no onResponse hook");

  return call[1] as (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ) => void;
}

afterEach(() => {
  container.delete("http.server");
  createServerMock.mockReset();
  vi.restoreAllMocks();
});

describe("WebConnector — lifecycle placement", () => {
  it("is a Late connector, so boot() runs after HttpConnector published Fastify", () => {
    const connector = new WebConnector();

    expect(connector.lifecyclePhase).toBe(ConnectorLifecyclePhase.Late);
  });

  it("sorts strictly between HTTP and STORAGE, read from core's own enum", () => {
    const connector = new WebConnector();

    // Against `ConnectorPriority`, never against the literal 5.5: reordering
    // core's enum (`core/src/connectors/types.ts:181-188`) must fail HERE, at
    // the connector that depends on the ordering, and not silently at runtime
    // during a shutdown that now closes Vite after the HTTP server.
    expect(connector.priority).toBeGreaterThan(ConnectorPriority.HTTP);
    expect(connector.priority).toBeLessThan(ConnectorPriority.STORAGE);
    expect(WEB_CONNECTOR_PRIORITY).toBe(connector.priority);
  });

  it("watches no files and stays inert before a development boot", () => {
    const connector = new WebConnector();

    // The synchronous watcher seam must not load or act before development boot
    // has supplied Vite and resolved the application's page root.
    expect(connector.shouldRestart()).toBe(false);
    expect(connector.shouldRestart(["src/app/main/web/home.page.tsx"])).toBe(false);
    expect(connector.shouldRestart(["src/config/http.ts"])).toBe(false);
  });
});

describe("WebConnector — start() does not own a listener", () => {
  it("never calls listen(): HttpConnector.start() owns the single listen for the process", async () => {
    const harness = await bootHarness();

    await harness.connector.start();

    // Both surfaces a stray `listen()` could be written against.
    expect(harness.fastify.listen).not.toHaveBeenCalled();
    expect(harness.rawServer.listen).not.toHaveBeenCalled();
    expect(harness.connector.isActive()).toBe(true);
  });

  it("stays inactive when start() runs without a booted Vite", async () => {
    const connector = new WebConnector();

    await connector.start();

    expect(connector.isActive()).toBe(false);
  });
});

describe("WebConnector — the Vite config it builds", () => {
  it("runs Vite in middleware mode with appType custom, so Warlock owns the response", async () => {
    const harness = await bootHarness();

    expect(harness.viteConfig.appType).toBe("custom");
    expect(harness.viteConfig.server?.middlewareMode).toBe(true);
  });

  it("hands HMR the Fastify raw server itself, and declares no port of its own", async () => {
    const harness = await bootHarness();
    const hmr = harness.viteConfig.server?.hmr as Record<string, unknown>;

    // Identity, not shape: HMR must share the ONE port the
    // app listens on, which only holds if this is the very server object
    // `HttpConnector` will call `listen()` on.
    expect(hmr.server).toBe(harness.fastify.server);

    // A `port` or `clientPort` here forks HMR onto a second port and the
    // single-port guarantee is gone — silently, since HMR still "works" locally.
    expect(hmr).not.toHaveProperty("port");
    expect(hmr).not.toHaveProperty("clientPort");

    // Key-set equality so ANY future addition to `hmr` has to come through
    // this test rather than past it.
    expect(Object.keys(hmr)).toEqual(["server"]);
  });

  it("mounts Vite's connect stack as an onRequest hook that yields via done()", async () => {
    const harness = await bootHarness();
    const hook = onRequestHook(harness);

    const request = { raw: { url: "/@vite/client" } } as unknown as FastifyRequest;
    const reply = { raw: {} } as unknown as FastifyReply;
    const done = vi.fn();

    hook(request, reply, done);

    // The raw node req/res, not the Fastify wrappers — Vite's middleware is a
    // plain Connect stack (`web-connector.ts:209-214`).
    const [passedRequest, passedResponse, next] = harness.vite.middlewares.mock.calls[0]!;

    expect(passedRequest).toBe(request.raw);
    expect(passedResponse).toBe(reply.raw);

    // `next` is NOT `done` itself: it is a wrapper that first asks whether Vite
    // dropped a transform failure on this request (`dev-server.ts`'s
    // `sendCapturedDevError`). With nothing captured — the normal case — it
    // must be indistinguishable from having passed `done` straight through.
    expect(next).not.toBe(done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("answers a request Vite refused with the captured error instead of yielding", async () => {
    const harness = await bootHarness();
    const hook = onRequestHook(harness);

    const chunks: string[] = [];
    const raw = {
      url: "/src/web/root.tsx",
      headersSent: false,
      writableEnded: false,
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body: string) => chunks.push(body),
    };

    const request = {
      raw: { url: "/src/web/root.tsx", [DEV_TRANSFORM_ERROR_BODY]: "ProjectionAmbiguityError: nope\n" },
    } as unknown as FastifyRequest;
    const reply = { raw } as unknown as FastifyReply;
    const done = vi.fn();

    hook(request, reply, done);

    // The whole point: the framework's routing never runs, so nothing can turn
    // a refused module into "route not found".
    expect(done).not.toHaveBeenCalled();
    expect(raw.statusCode).toBe(500);
    expect(chunks.join("")).toContain("ProjectionAmbiguityError: nope");
  });
});

describe("WebConnector unregistered global page diagnostic", () => {
  it("passes the pathname to the reporter, keeping unrelated 404s silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const temporaryAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-unregistered-page-"));
    const temporaryAppSrcRoot = path.join(temporaryAppRoot, "src");

    try {
      fs.mkdirSync(path.join(temporaryAppSrcRoot, "web"), { recursive: true });
      fs.writeFileSync(
        path.join(temporaryAppSrcRoot, "web", "about.page.tsx"),
        'export const route = "/about";\nexport default () => null;\n',
      );

      const harness = await bootHarness(ownGraph, temporaryAppSrcRoot, temporaryAppRoot);
      const hook = onResponseHook(harness);
      const done = vi.fn();

      hook(
        { method: "GET", url: "/missing" } as FastifyRequest,
        { statusCode: 404 } as FastifyReply,
        done,
      );
      expect(warn).not.toHaveBeenCalled();

      hook(
        { method: "GET", url: "/about?from=404" } as FastifyRequest,
        { statusCode: 404 } as FastifyReply,
        done,
      );

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("src/web/about.page.tsx");
      expect(done).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(temporaryAppRoot, { recursive: true, force: true });
    }
  });
});

describe("WebConnector — shutdown", () => {
  it("drops the raw sockets Vite wrote to BEFORE closing Vite", async () => {
    const harness = await bootHarness();

    await harness.connector.start();
    await harness.connector.shutdown();

    // Order is the assertion. Vite's connect stack writes straight to
    // `reply.raw`, so Fastify never counts those keep-alive sockets idle and
    // core's `forceCloseConnections: "idle"` would wait on them forever
    // (`web-connector.ts:249-261`).
    expect(harness.order).toEqual(["sockets-closed", "vite-closed"]);
    expect(harness.connector.isActive()).toBe(false);
    expect(harness.connector.getInstalledPages()).toEqual([]);
  });

  it("is a no-op when the connector was never started", async () => {
    const harness = await bootHarness();

    await harness.connector.shutdown();

    expect(harness.rawServer.closeAllConnections).not.toHaveBeenCalled();
    expect(harness.vite.close).not.toHaveBeenCalled();
  });
});

describe("WebConnector — module identity of the pipeline barrel", () => {
  /**
   * THE test this file exists for.
   *
   * `boot()` loads `web/src/server/index.ts` through `vite.ssrLoadModule`
   * (`web-connector.ts:198`) rather than a plain `import`. That is not a
   * stylistic choice: page modules are evaluated inside Vite's SSR module
   * graph, so `connectSharedStore`/`connectPageContext` must land on VITE's
   * copy of `web/src/shared`. A plain `import` here resolves through node and
   * produces a SECOND module instance — the connector wires that one, the
   * pages read the other, and every page renders with an unconnected shared
   * store. Nothing throws; pages just come back empty.
   *
   * This asserts the real property, not a proxy for it: a sentinel resolver is
   * planted on THIS process's barrel instance before boot, and must still be
   * there afterwards. Swap `ssrLoadModule` for `await import(...)` and the
   * connector overwrites the sentinel — which is precisely the bug.
   */
  it("wires VITE's module instance and leaves this process's own barrel untouched", async () => {
    const sentinel: SharedStoreResolver = () => ({}) as never;
    const previous = connectSharedStore(sentinel);

    try {
      const harness = await bootHarness();

      // The load-bearing assertion, deliberately FIRST so that it — and not a
      // spy count — is what reports when someone swaps in a plain `import`.
      // `connectSharedStore` returns the previous resolver
      // (`web/src/shared.ts:78-84`), so reading it back says whether anything
      // overwrote the sentinel on THIS process's module instance.
      const currentResolver = connectSharedStore(sentinel);

      expect(currentResolver).toBe(sentinel);

      // Positive half — the barrel was requested from Vite, by path...
      expect(harness.vite.ssrLoadModule).toHaveBeenCalledWith(webServerBarrel);

      // ...and VITE's copy is the one that got wired.
      expect(harness.webServerModule.connectSharedStore).toHaveBeenCalledTimes(1);
      expect(harness.webServerModule.connectPageContext).toHaveBeenCalledTimes(1);
      expect(harness.webServerModule.connectSharedStore.mock.calls[0][0]).toBeTypeOf("function");
    } finally {
      connectSharedStore(previous);
    }
  });

  /**
   * The other half of the same property, and the half that only bites once the
   * package is INSTALLED.
   *
   * The test above proves the PIPELINE is loaded through Vite. It says nothing
   * about the app: `root.tsx` imports `@warlock.js/web` by name, and Vite
   * externalises `node_modules` in SSR by default, so in a published install
   * node loads a SECOND copy. `renderPage` sets the document context on Vite's
   * copy; the app's `<Head/>` reads node's, finds nothing, and throws
   * "rendered outside the page pipeline's document context" — a 500 on the home
   * page of every scaffolded app. Measured on published 5.0.1.
   *
   * It cannot reproduce in this checkout, because here the package resolves to
   * source under Vite's root and never through `node_modules` — which is why
   * this asserts the CONFIG rather than a render. Canon `6b7ab838`.
   */
  it("marks @warlock.js/web noExternal so an INSTALLED app shares the pipeline's instance", async () => {
    const harness = await bootHarness();

    expect(harness.viteConfig.ssr?.noExternal).toContain("@warlock.js/web");
  });

  it("registers pages through VITE's installPageRoutes, on the same Vite the middleware serves", async () => {
    const harness = await bootHarness();

    expect(harness.webServerModule.installPageRoutes).toHaveBeenCalledTimes(1);

    const options = harness.webServerModule.installPageRoutes.mock.calls[0][0] as {
      router: unknown;
      vite: unknown;
      appSrcRoot: string;
      appFile: string;
      hydrationClientModuleUrl: string;
      applyBufferedCookie: unknown;
    };

    // One router, one Vite — pages must render through the SAME dev server
    // that answers their asset requests, or transformed page modules and
    // served client chunks come from two different graphs.
    expect(options.router).toBe(router);
    expect(options.vite).toBe(harness.vite);
    expect(options.hydrationClientModuleUrl.startsWith("/@fs/")).toBe(true);
    expect(options.applyBufferedCookie).toBeTypeOf("function");

    /*
      THE APP ROOT PATH, asserted rather than merely destructured.

      `appFile` was already pulled out of these options above and then thrown
      away, so nothing checked where the connector points when an application
      supplies no `appFile` of its own — which is exactly what the reference app
      does. The value therefore rides entirely on the default in
      `web-connector.ts`, and a default nothing asserts is a default that can be
      changed by a rename with the whole suite still green.

      Asserted as a suffix, not an absolute path: the app root is a temporary
      directory here, so only the part the connector actually decides is
      meaningful.
    */
    expect(options.appFile).toBe(path.join(options.appSrcRoot, "web/root.tsx"));

    // The marker can only have come from the doubled module.
    expect(harness.connector.getInstalledPages()).toEqual(INSTALLED_PAGES_MARKER);
  });
});

/**
 * THE MODE BRANCH.
 *
 * `consumePageManifest()` returning `undefined` is a FACT, not an error — the
 * registry deliberately never throws on absence. The connector is where that
 * fact acquires a meaning, and the rule is that it acquires it from the MODE
 * and never from the value: dev has no build so the
 * absence is normal, production without page modules is a server that 404s
 * every page while its health check stays green.
 *
 * These tests hold the branch to that shape. The trap they exist to catch is a
 * future `if (!manifest) throw` — correct-looking, and it breaks `warlock dev`
 * for every app on the first boot.
 */
describe("WebConnector — the manifest mode branch", () => {
  const manifest: PageManifest = {
    app: { module: {}, sourceFile: "src/web/root.tsx" },
    pages: [],
  };

  it("refuses to boot in production when no page manifest was provided", async () => {
    const graph = await freshWebGraph();

    inProduction(graph);

    // The real registry, untouched in this module instance: nothing provided
    // it, so this is genuinely the "no barrel ran" state the branch reads.
    expect(graph.consumePageManifest()).toBeUndefined();

    graph.container.set("http.server", { server: {}, addHook: vi.fn() } as never);

    const connector = new graph.WebConnector({ appSrcRoot });

    // Named error, and the message says WHICH half of the handoff is missing
    // plus the command that produces it — a prod boot log has to be actionable
    // by someone who has never seen this codebase.
    await expect(connector.boot()).rejects.toThrow(graph.WebPageManifestMissingError);
    await expect(connector.boot()).rejects.toThrow(/without a page manifest/i);
    await expect(connector.boot()).rejects.toThrow(/warlock build/i);

    // It fails BEFORE standing anything up. A half-booted prod page surface
    // is the failure mode this branch exists to prevent, not a milder one.
    expect(createServerMock).not.toHaveBeenCalled();
  });

  it("boots normally in development when no page manifest was provided", async () => {
    // Same registry state as the test above — nothing provided, so
    // `consumePageManifest()` really is undefined in both. Only the mode
    // differs, which is the whole claim.
    const graph = await freshWebGraph();

    inDevelopment(graph);

    expect(graph.consumePageManifest()).toBeUndefined();

    const harness = await bootHarness(graph);

    expect(harness.connector.getPageManifest()).toBeUndefined();
    expect(harness.webServerModule.installPageRoutes).toHaveBeenCalledTimes(1);

    // And dev still gets Vite's own `/@fs/` URL, not a manifest lookup.
    const options = harness.webServerModule.installPageRoutes.mock.calls[0][0] as {
      hydrationClientModuleUrl: string;
    };

    expect(options.hydrationClientModuleUrl.startsWith("/@fs/")).toBe(true);
  });

  it(
    "gets past the manifest branch in production, and registers the manifest's pages",
    async () => {
      await withClientBuild(async () => {
        const graph = await freshWebGraph();
        const providedManifest = manifestWithOnePage();

        // Filled the way the generated barrel fills it: one real
        // `providePageManifest` call into the real registry.
        graph.providePageManifest(providedManifest);
        inProduction(graph);

        expect(graph.consumePageManifest()).toBe(providedManifest);

        const registered = recordRoutes(graph);
        const connector = new graph.WebConnector({ appSrcRoot });

        // The manifest was there, so the branch lets the boot THROUGH and the
        // boot goes on to do the work the manifest exists for. A
        // `WebPageManifestMissingError` here would mean the branch had stopped
        // reading the mode and started reading the value.
        await connector.boot();

        expect(registered).toEqual([
          { path: "/products", name: "main.products" },
          // The catch-all, registered last and belonging to the framework
          // rather than to the application: it answers every URL that no page
          // and no API route claimed, with a 404 status either way.
          { path: "*", name: "warlock.not-found" },
        ]);
        expect(connector.getPageManifest()).toBe(providedManifest);
        expect(connector.getInstalledPages()).toEqual([
          {
            declaredPath: "/products",
            path: "/products",
            name: "main.products",
            file: "src/app/main/web/products.page.tsx",
            layoutFile: undefined,
          },
        ]);
      });
    },
    COLD_GRAPH_TIMEOUT,
  );

  it(
    "reads the built hydration URL in production, never Vite's dev URL",
    async () => {
      // Through `boot()`, like every other caller: the production path resolves
      // the URL itself and hands it to the manifest registration step, so the
      // value the browser will be pointed at is observable where it lands
      // instead of at the connector's own protected resolver.
      await withClientBuild(async () => {
        const graph = await freshWebGraph();

        graph.providePageManifest(manifestWithOnePage());
        inProduction(graph);
        recordRoutes(graph);

        const installFromManifest = vi.spyOn(graph.webServer, "installPageRoutesFromManifest");
        const connector = new graph.WebConnector({ appSrcRoot });

        await connector.boot();

        // The hashed filename off the client build's manifest — not Vite's
        // `/@fs/` dev URL, which a built artifact has no server to serve.
        expect(installFromManifest).toHaveBeenCalledTimes(1);
        expect(installFromManifest.mock.calls[0][0].hydrationClientModuleUrl).toBe(
          "/assets/hydration-abc123.js",
        );
      });
    },
    COLD_GRAPH_TIMEOUT,
  );

  it(
    "treats an empty page table as provided, not as a missing manifest",
    async () => {
      // "Built with web, and it has no pages" is a REAL state, and the registry
      // keeps it distinguishable from "never built" rather than collapsing both
      // into one falsy read. The branch must honour that distinction: a
      // `!manifest.pages.length` creeping in beside the `!manifest` check would
      // make every page-free production bundle refuse to boot.
      //
      // Deliberately with NO client build on disk. A build that found no pages
      // emits no hydration entry, so a boot that demanded one would make a
      // page-free bundle unbootable for a file it had no reason to produce.
      withoutClientBuild();

      const graph = await freshWebGraph();
      const emptyManifest: PageManifest = { pages: [] };

      graph.providePageManifest(emptyManifest);
      inProduction(graph);

      const registered = recordRoutes(graph);
      const connector = new graph.WebConnector({ appSrcRoot });

      // An empty table counts as PROVIDED: the boot completes rather than
      // failing at the manifest branch, and it registers nothing because there
      // is nothing in the table to register.
      await connector.boot();

      const read = connector.getPageManifest();

      expect(read).toBe(emptyManifest);
      expect(read?.pages).toHaveLength(0);
      // No app root either — a build that found no pages has nothing to wrap.
      expect(read?.app).toBeUndefined();
      expect(registered).toEqual([]);
      expect(connector.getInstalledPages()).toEqual([]);
    },
    COLD_GRAPH_TIMEOUT,
  );

  it("re-reads the registry on a later boot, so a restarted connector still passes the branch", async () => {
    // `shutdown()` drops the connector's copy of the manifest, and the
    // registry is not a queue: reading it does not empty it. If it ever became
    // consume-once, a connector that shut down and came back would throw the
    // production boot error with the barrel having run perfectly well.
    //
    // Driven in DEVELOPMENT, because that is the mode whose boot still
    // completes — the claim is about the registry surviving a boot/shutdown
    // cycle, and the registry is the same object in both modes.
    const graph = await freshWebGraph();

    graph.providePageManifest(manifest);
    inDevelopment(graph);

    const harness = await bootHarness(graph);

    expect(harness.connector.getPageManifest()).toBe(manifest);

    await harness.connector.start();
    await harness.connector.shutdown();

    expect(harness.connector.getPageManifest()).toBeUndefined();

    await harness.connector.boot();

    expect(harness.connector.getPageManifest()).toBe(manifest);
    expect(graph.consumePageManifest()).toBe(manifest);
  });

  it(
    "fails loudly in production when the client build manifest is absent",
    async () => {
      // Never a fallback: a page that renders and then never hydrates is the
      // outcome the hydration URL resolver refuses to produce, and the boot it
      // refuses to complete is the one that would serve those pages.
      //
      // Through `boot()`, and with a manifest that carries a PAGE — the URL is
      // read only when there is something to hydrate, so a page-free table
      // would never reach the read this case is about.
      withoutClientBuild();

      const graph = await freshWebGraph();

      graph.providePageManifest(manifestWithOnePage());
      inProduction(graph);

      const registered = recordRoutes(graph);
      const connector = new graph.WebConnector({ appSrcRoot });

      await expect(connector.boot()).rejects.toThrow(graph.WebClientManifestMissingError);

      // And nothing was registered on the way to that refusal: a page surface
      // that serves documents no browser can hydrate is the outcome, not a
      // milder one.
      expect(registered).toEqual([]);
    },
    COLD_GRAPH_TIMEOUT,
  );
});

/**
 * NO VITE ON THE PRODUCTION PATH.
 *
 * Vite is a development dependency. A production boot that walks into
 * `createViteServer` does not fail with something a reader could diagnose — it
 * fails with a module resolution error for a package a production install has
 * no reason to carry, on the one code path that is supposed to contain no Vite
 * at all. The production path takes its pages from the manifest the build handed
 * over and touches none of it.
 *
 * The case below reaches the branch through the connector's OWN mode decision:
 * a real registry filled by a real `providePageManifest`, a real runtime
 * strategy on the graph's own `Application`, and a real client build on disk —
 * so a manifest-shaped double cannot be what makes it pass.
 */
describe("WebConnector — production page serving", () => {
  it(
    "boots in production without constructing a dev-only Vite server",
    async () => {
      // A fully, correctly built app: manifest provided, client bundle on disk.
      // Everything the connector reads before the branch is satisfied, which is
      // what makes this the exact path a stray `createServer` would be on.
      await withClientBuild(async () => {
        const graph = await freshWebGraph();

        graph.providePageManifest(manifestWithOnePage());
        inProduction(graph);

        // No Fastify published, deliberately: production mounts no middleware
        // and needs no HMR socket, so it must not depend on the HTTP
        // connector's instance the way the development path does.
        const registered = recordRoutes(graph);
        const connector = new graph.WebConnector({ appSrcRoot });

        await connector.boot();

        // It boots, and the pages are on the router.
        expect(registered).toEqual([
          { path: "/products", name: "main.products" },
          // The catch-all, registered last and belonging to the framework
          // rather than to the application: it answers every URL that no page
          // and no API route claimed, with a 404 status either way.
          { path: "*", name: "warlock.not-found" },
        ]);

        // THE property this case exists for: a production boot that serves
        // pages still never touches the dev-only half.
        expect(createServerMock).not.toHaveBeenCalled();
      });
    },
    COLD_GRAPH_TIMEOUT,
  );
});

describe("WebConnector — required collaborators", () => {
  it("fails loudly when HttpConnector never published a Fastify instance", async () => {
    container.delete("http.server");

    const connector = new WebConnector();

    // The alternative — a silent no-op — surfaces as every page 404ing with
    // no explanation (`web-connector.ts:281-292`).
    await expect(connector.boot()).rejects.toThrow(/http\.server/);
    expect(createServerMock).not.toHaveBeenCalled();
  });
});
