import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectPageContext,
  executePageRequest,
  type PageContextRunner,
  type PageRouteEntry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import { routes } from "./fixtures/routes";

/**
 * Stage 6/7 contracts: loaders run root-to-leaf against buffered responses;
 * commit is root→leaf per cookie name / header key; a throw discards the
 * throwing layer's buffer and prevents lower loaders; a short-circuit
 * (redirect/notFound) keeps its own buffer and also prevents lower loaders.
 */

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as any);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

function runInline(triple: PageRouteEntry["triple"], url = "/inline") {
  const created: ReturnType<typeof createCoreHttp>[] = [];

  const result = executePageRequest({
    url,
    routes: [{ path: "/inline", name: "inline", triple }],
    createHttp(match) {
      const http = createCoreHttp({ url, params: match.params, query: match.query });
      created.push(http);
      return http;
    },
  });

  return { result, created };
}

describe("executePageRequest — loaders are root-to-leaf", () => {
  it("awaits each loader before starting the next", async () => {
    const order: string[] = [];

    const loaderFor = (level: string) => async () => {
      order.push(`${level}:start`);
      await tick();
      order.push(`${level}:end`);
      return { level };
    };

    const { result } = runInline({
      app: { loader: loaderFor("app") },
      layout: { loader: loaderFor("layout") },
      page: { loader: loaderFor("page") },
    });

    const bundle = await result;

    expect(order).toEqual([
      "app:start",
      "app:end",
      "layout:start",
      "layout:end",
      "page:start",
      "page:end",
    ]);

    expect(bundle!.appData).toEqual({ level: "app" });
    expect(bundle!.layoutData).toEqual({ level: "layout" });
    expect(bundle!.pageData).toEqual({ level: "page" });
  });
});

describe("executePageRequest — buffered commit, root→leaf per key", () => {
  it("a leafward level wins its header key (case-insensitively) and its cookie name", async () => {
    const { result, created } = runInline({
      app: {
        loader: async ({ response }: any) => {
          response.header("X-Shared", "app");
          response.header("x-app-only", "1");
          response.cookie("session", "app-value");
          return {};
        },
      },
      layout: {
        loader: async ({ response }: any) => {
          response.header("x-shared", "layout");
          return {};
        },
      },
      page: {
        loader: async ({ response }: any) => {
          response.header("X-SHARED", "page");
          response.cookie("session", "page-value");
          return {};
        },
      },
    });

    const bundle = await result;
    const { reply } = created[0];

    // One write per key reached the real reply — the leaf-most value.
    expect(reply.appliedHeaders["x-shared"]).toBe("page");
    expect(reply.appliedHeaders["x-app-only"]).toBe("1");

    // COOKIES ARE NOT MIRRORED ONTO THE LIVE RESPONSE, and this used to assert
    // that they were. `header()` is a keyed SET, so mirroring it here and
    // applying it again at the emit is idempotent; `cookie()` APPENDS, so the
    // same mirror put a second identical `Set-Cookie` on every page response
    // (`page-redirect-wire.spec.ts` asserted the duplicate on purpose until it
    // was removed). The settle result below is how a cookie leaves this stage
    // now — the emit is the single application site.
    expect(reply.cookies).toEqual([]);

    expect(bundle!.commit).toMatchObject({ committedLevels: ["app", "layout", "page"] });
    expect(bundle!.commit!.headers).toEqual([
      { key: "X-SHARED", value: "page" },
      { key: "x-app-only", value: "1" },
    ]);
    expect(bundle!.commit!.cookies).toEqual([
      expect.objectContaining({ name: "session", value: "page-value" }),
    ]);
  });
});

describe("executePageRequest — a loader throw", () => {
  it("page throw: siblings' data intact field-by-field, page boundary designated, final status deferred", async () => {
    const failure = new Error("page loader exploded");

    const { result, created } = runInline({
      app: {
        loader: async ({ response }: any) => {
          response.header("x-from-app", "kept");
          return { appName: "Fixture Store", features: ["a", "b"] };
        },
      },
      layout: {
        loader: async () => ({ nav: ["home"], badge: 3 }),
      },
      page: {
        loader: async ({ response }: any) => {
          response.header("x-from-page", "must-be-discarded");
          throw failure;
        },
        ErrorBoundary: () => null,
      },
    });

    const bundle = await result;
    const { reply } = created[0];

    // Boundary designation: the throwing level's own boundary renders.
    expect(bundle!.error).toEqual({
      error: failure,
      boundary: { throwingLevel: "page", boundaryLevel: "page" },
      digest: expect.any(String),
      scrubbed: false,
    });

    // Siblings' data intact, field by field.
    expect(bundle!.appData).toEqual({ appName: "Fixture Store", features: ["a", "b"] });
    expect(bundle!.layoutData).toEqual({ nav: ["home"], badge: 3 });
    expect(bundle!.pageData).toBeUndefined();

    // The throwing layer's buffer is discarded and rootward buffers commit.
    // This stage does not write a status for a nested boundary: renderPage
    // chooses the final status after the boundary itself has rendered.
    expect(reply.appliedHeaders["x-from-app"]).toBe("kept");
    expect(reply.appliedHeaders["x-from-page"]).toBeUndefined();
    expect(bundle!.commit).toMatchObject({
      committedLevels: ["app", "layout"],
      statusCode: undefined,
    });
    expect(created[0].response.statusCode).toBe(200);
  });

  it("layout throw with no layout/app boundary: designation falls back to the app root", async () => {
    const pageLoader = vi.fn(async ({ response }: any) => {
      response.header("x-from-page", "must-not-run");
      return { still: "computed" };
    });
    const { result, created } = runInline({
      app: {
        loader: async ({ response }: any) => {
          response.header("x-from-app", "kept");
          return { ok: true };
        },
      },
      layout: {
        loader: async ({ response }: any) => {
          response.header("x-from-layout", "discarded");
          throw new Error("layout down");
        },
      },
      page: {
        loader: pageLoader,
      },
    });

    const bundle = await result;
    const { reply } = created[0];

    expect(bundle!.error!.boundary).toEqual({ throwingLevel: "layout", boundaryLevel: "app" });

    expect(pageLoader).not.toHaveBeenCalled();
    expect(bundle!.pageData).toBeUndefined();
    expect(reply.appliedHeaders["x-from-app"]).toBe("kept");
    expect(reply.appliedHeaders["x-from-layout"]).toBeUndefined();
    expect(reply.appliedHeaders["x-from-page"]).toBeUndefined();
    expect(bundle!.commit).toMatchObject({ committedLevels: ["app"], statusCode: 500 });
  });
});

describe("executePageRequest — loader short-circuits", () => {
  it("layout redirect: own buffer commits, page's buffer AND data are discarded, metadata skipped", async () => {
    const pageMetadata = vi.fn(() => ({ title: "never" }));
    const pageLoader = vi.fn(async ({ response }: any) => {
      response.header("x-from-page", "must-not-run");
      return { secret: "must not surface" };
    });

    const { result, created } = runInline({
      app: {
        loader: async () => ({ ok: true }),
      },
      layout: {
        loader: async ({ response }: any) => {
          response.cookie("intended-url", "/inline");
          return response.redirect("/login");
        },
      },
      page: {
        loader: pageLoader,
        metadata: pageMetadata,
      },
    });

    const bundle = await result;
    const { reply } = created[0];

    expect(bundle!.shortCircuit).toEqual({
      stage: "loaders",
      level: "layout",
      kind: "redirect",
      statusCode: 302,
      url: "/login",
      body: undefined,
    });

    // The signalling layer's own buffer commits (its cookie + status) — as a
    // SETTLE RESULT, not as a live-response write. This is the case that
    // proved the de-duplication safe: it is the only spec that covered a
    // short-circuit committing a cookie, so if the emit did NOT carry
    // `commit.cookies` to the wire, deleting the mirror would drop a session
    // cookie on every guard redirect. It does carry it — asserted at the wire,
    // where a bundle-level spec like this one cannot see it, in
    // `page-redirect-wire.spec.ts` ("loader redirect (LAYOUT level)").
    expect(reply.cookies).toEqual([]);
    expect(bundle!.commit!.cookies).toEqual([
      expect.objectContaining({ name: "intended-url", value: "/inline" }),
    ]);
    expect(bundle!.commit).toMatchObject({
      committedLevels: ["app", "layout"],
      statusCode: 302,
    });
    // The level below never starts.
    expect(pageLoader).not.toHaveBeenCalled();
    expect(reply.appliedHeaders["x-from-page"]).toBeUndefined();
    expect(bundle!.pageData).toBeUndefined();
    expect(bundle!.appData).toEqual({ ok: true });
    // stage 8 does not run for a short-circuited page
    expect(pageMetadata).not.toHaveBeenCalled();
    expect(bundle!.metadata).toBeUndefined();
  });

  it("fixture notFound: page loader answers 404 through the bundle, not an ErrorBoundary", async () => {
    const url = "/products/missing";

    const bundle = await executePageRequest({
      url,
      routes,
      createHttp: match => createCoreHttp({ url, params: match.params, query: match.query }),
    });

    expect(bundle!.shortCircuit).toEqual({
      stage: "loaders",
      level: "page",
      kind: "notFound",
      statusCode: 404,
      url: undefined,
      body: undefined,
    });
    // A 404 is an ANSWER, not an incident (product-details.page.tsx:51-53):
    expect(bundle!.error).toBeUndefined();
    // The signalling level keeps its buffer (the 404 status), root levels keep data.
    expect(bundle!.commit).toMatchObject({
      committedLevels: ["app", "layout", "page"],
      statusCode: 404,
    });
    expect(bundle!.appData).toEqual({ appName: "Fixture Store" });
    expect(bundle!.layoutData).toEqual({ nav: ["home", "products"], locale: "en" });
    expect(bundle!.pageData).toBeUndefined();
    expect(bundle!.metadata).toBeUndefined();
  });
});
