import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteRegistry, type HttpContext, type Route, type Router } from "@warlock.js/core";
import type { SitemapGenerationManifest } from "@warlock.js/sitemap";
import { registerSitemapRoutes } from "./register-sitemap-routes";
import type { SitemapServingState } from "./sitemap-serving-state";

const digest = "a".repeat(64);

function manifest(overrides: Partial<SitemapGenerationManifest> = {}): SitemapGenerationManifest {
  return {
    version: 1,
    fence: 3,
    generationId: "current_3",
    coversRev: 3,
    kind: "index",
    mainFile: "generations/current_3/sitemap_index.xml",
    files: [
      { path: "generations/current_3/sitemap_index.xml", bytes: 12, sha256: digest },
      { path: "generations/current_3/sitemap-0001.xml.gz", bytes: 8, sha256: digest },
    ],
    entries: 1,
    generatedAt: "2026-09-24T12:34:56.000Z",
    ...overrides,
  };
}

function capturingRouter() {
  const routes = new Map<string, (context: HttpContext) => unknown>();
  const headRoutes = new Map<string, (context: HttpContext) => unknown>();
  const router = {
    get: vi.fn((routePath: string, handler: (context: HttpContext) => unknown) => {
      routes.set(routePath, handler);
    }),
    head: vi.fn((routePath: string, handler: (context: HttpContext) => unknown) => {
      headRoutes.set(routePath, handler);
    }),
  } as unknown as Router;

  return { router, routes, headRoutes };
}

function dispatchingRegistry(
  routes: ReadonlyMap<string, (context: HttpContext) => unknown>,
  headRoutes: ReadonlyMap<string, (context: HttpContext) => unknown>,
): RouteRegistry {
  const registry = new RouteRegistry();
  const route = (
    method: "GET" | "HEAD",
    routePath: string,
    handler: (context: HttpContext) => unknown,
  ): Route =>
    ({
      method,
      path: routePath,
      handler: handler as Route["handler"],
      sourceFile: "sitemap-route.spec.ts",
      $prefix: "",
      $prefixStack: [],
    }) as Route;

  registry.register([
    ...[...routes].map(([routePath, handler]) => route("GET", routePath, handler)),
    ...[...headRoutes].map(([routePath, handler]) => route("HEAD", routePath, handler)),
  ]);

  return registry;
}

function fakeResponse() {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]) => {
    calls[name] = [...(calls[name] ?? []), args];
  };
  const response: Record<string, unknown> = {
    header: (...args: unknown[]) => {
      record("header", args);
      return response;
    },
    setStatusCode: (...args: unknown[]) => {
      record("setStatusCode", args);
      return response;
    },
    send: async (...args: unknown[]) => {
      record("send", args);
      return response;
    },
    serviceUnavailable: (...args: unknown[]) => {
      record("serviceUnavailable", args);
      return response;
    },
    notFound: (...args: unknown[]) => {
      record("notFound", args);
      return response;
    },
    baseResponse: {
      send: (...args: unknown[]) => {
        record("baseResponse.send", args);
        return response;
      },
    },
  };

  return { response, calls };
}

function context(
  response: Record<string, unknown>,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
  method = "GET",
  missingHeader: string | null | undefined = undefined,
): HttpContext {
  return {
    request: {
      params,
      method,
      header: (name: string) => headers[name.toLowerCase()] ?? missingHeader,
    },
    response,
  } as unknown as HttpContext;
}

function stateFor(current: SitemapGenerationManifest | undefined) {
  const store = {
    getArtifactStream: vi.fn(async () => Readable.from([Buffer.from("<xml />")])),
    readManifestByGeneration: vi.fn(
      async (): Promise<SitemapGenerationManifest | undefined> => undefined,
    ),
  };
  const state: SitemapServingState = {
    store: store as unknown as SitemapServingState["store"],
    cacheControl: "public, max-age=300",
    getManifest: vi.fn(async () => current),
  };

  return { state, store, current };
}

describe("registerSitemapRoutes — manifest-backed serving", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers GET and HEAD dispatch handlers for every readable sitemap artifact route", () => {
    const { router, routes, headRoutes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => undefined });

    const expectedPaths = [
      "/sitemap.xml",
      "/sitemaps/:sitemapGenerationId/:sitemapGenerationFile",
      "/:sitemapArtifactFile",
    ];

    expect([...routes.keys()]).toEqual(expectedPaths);
    expect([...headRoutes.keys()]).toEqual(expectedPaths);

    const dispatcher = dispatchingRegistry(routes, headRoutes);

    for (const path of [
      "/sitemap.xml",
      "/sitemaps/current_3/sitemap-0001.xml",
      "/sitemap-0001.xml",
    ]) {
      expect(dispatcher.find("GET", path)?.route.method).toBe("GET");
      expect(dispatcher.find("HEAD", path)?.route.method).toBe("HEAD");
    }
  });

  it("returns 503 with Retry-After before a serving state exists", async () => {
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, {
      path: "/sitemap.xml",
      warn: () => undefined,
      getServingState: () => undefined,
    });
    const { response, calls } = fakeResponse();

    await routes.get("/sitemap.xml")!(context(response));

    expect(calls.serviceUnavailable).toBeDefined();
    expect(calls.header).toContainEqual(["Retry-After", "30"]);
  });

  it("returns 304 from manifest validators without opening an artifact stream", async () => {
    const { state, store } = stateFor(manifest());
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });
    const { response, calls } = fakeResponse();

    await routes.get("/sitemap.xml")!(context(response, {}, { "if-none-match": `W/"${digest}"` }));

    expect(calls.setStatusCode).toEqual([[304]]);
    expect(calls.header).toContainEqual(["ETag", `"${digest}"`]);
    expect(calls.header).toContainEqual(["Cache-Control", "public, max-age=300"]);
    expect(store.getArtifactStream).not.toHaveBeenCalled();
  });

  it("streams the current main artifact after validator handling", async () => {
    const current = manifest();
    const { state, store } = stateFor(current);
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });
    const { response, calls } = fakeResponse();

    await routes.get("/sitemap.xml")!(context(response));

    expect(store.getArtifactStream).toHaveBeenCalledWith(current, current.mainFile);
    expect(calls["baseResponse.send"]).toHaveLength(1);
  });

  it("treats Core Request's null absent conditional headers as absent", async () => {
    const { state, store } = stateFor(manifest());
    const { router, routes, headRoutes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });

    const get = fakeResponse();
    await routes.get("/sitemap.xml")!(context(get.response, {}, {}, "GET", null));

    expect(get.calls["baseResponse.send"]).toHaveLength(1);
    expect(get.calls.header).toContainEqual(["ETag", `"${digest}"`]);

    const head = fakeResponse();
    await headRoutes.get("/sitemap.xml")!(context(head.response, {}, {}, "HEAD", null));

    expect(head.calls.send).toEqual([[]]);
    expect(store.getArtifactStream).toHaveBeenCalledTimes(1);
  });

  it("answers HEAD with validators and no artifact stream", async () => {
    const { state, store } = stateFor(manifest());
    const { router, headRoutes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });
    const { response, calls } = fakeResponse();

    await headRoutes.get("/sitemap.xml")!(context(response, {}, {}, "HEAD"));

    expect(calls.header).toContainEqual(["Content-Type", "application/xml"]);
    expect(calls.send).toEqual([[]]);
    expect(store.getArtifactStream).not.toHaveBeenCalled();
  });

  it("serves only a listed immutable generation file with immutable cache headers", async () => {
    const current = manifest();
    const previous = manifest({
      generationId: "previous_2",
      fence: 2,
      mainFile: "generations/previous_2/sitemap.xml",
      files: [{ path: "generations/previous_2/sitemap.xml", bytes: 4, sha256: digest }],
    });
    const { state, store } = stateFor(current);
    store.readManifestByGeneration.mockResolvedValue(previous);
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });
    const { response, calls } = fakeResponse();

    await routes.get("/sitemaps/:sitemapGenerationId/:sitemapGenerationFile")!(
      context(response, {
        sitemapGenerationId: "previous_2",
        sitemapGenerationFile: "sitemap.xml",
      }),
    );

    expect(store.readManifestByGeneration).toHaveBeenCalledWith("previous_2");
    expect(calls.header).toContainEqual(["Cache-Control", "public, max-age=31536000, immutable"]);
    expect(calls["baseResponse.send"]).toHaveLength(1);
  });

  it("rejects traversal-shaped or unlisted generation requests before storage streaming", async () => {
    const { state, store } = stateFor(manifest());
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });
    const { response, calls } = fakeResponse();

    await routes.get("/sitemaps/:sitemapGenerationId/:sitemapGenerationFile")!(
      context(response, { sitemapGenerationId: "../escape", sitemapGenerationFile: "sitemap.xml" }),
    );

    expect(calls.notFound).toBeDefined();
    expect(store.getArtifactStream).not.toHaveBeenCalled();
  });

  it("sets gzip content encoding from the listed filename without reading bytes first", async () => {
    const { state, store } = stateFor(manifest());
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", getServingState: () => state });
    const { response, calls } = fakeResponse();

    await routes.get("/sitemaps/:sitemapGenerationId/:sitemapGenerationFile")!(
      context(response, {
        sitemapGenerationId: "current_3",
        sitemapGenerationFile: "sitemap-0001.xml.gz",
      }),
    );

    expect(calls.header).toContainEqual(["Content-Encoding", "gzip"]);
    expect(store.getArtifactStream).toHaveBeenCalledTimes(1);
  });
});
