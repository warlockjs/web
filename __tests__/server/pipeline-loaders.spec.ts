import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
 * Stage 6/7 contracts: loaders run in PARALLEL against buffered responses;
 * settle is allSettled; commit is root→leaf per cookie name / header key; a
 * throw discards the throwing layer's buffer with its siblings' below it and
 * designates the boundary; a short-circuit (redirect/notFound) keeps its own
 * buffer and discards the levels below (canon 20c425dd §10,
 * design/request-lifecycle.md:47-54).
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

describe("executePageRequest — loaders are PARALLEL", () => {
  it("all three loaders START before any of them finishes (interleaving proof)", async () => {
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

    // Sequential execution would interleave start/end pairs
    // (app:start, app:end, layout:start, …). Parallel execution starts every
    // loader before the first await resolves:
    expect(order.slice(0, 3)).toEqual(["app:start", "layout:start", "page:start"]);
    expect(order.slice(3).sort()).toEqual(["app:end", "layout:end", "page:end"]);

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
    expect(reply.headers["x-shared"]).toBe("page");
    expect(reply.headers["x-app-only"]).toBe("1");
    expect(reply.cookies).toEqual([
      expect.objectContaining({ name: "session", value: JSON.stringify("page-value") }),
    ]);

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
  it("page throw: siblings' data intact field-by-field, page boundary designated, status framework-owned", async () => {
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
    });

    // Siblings' data intact, field by field.
    expect(bundle!.appData).toEqual({ appName: "Fixture Store", features: ["a", "b"] });
    expect(bundle!.layoutData).toEqual({ nav: ["home"], badge: 3 });
    expect(bundle!.pageData).toBeUndefined();

    // The throwing layer's buffer is discarded; rootward buffers commit.
    expect(reply.headers["x-from-app"]).toBe("kept");
    expect(reply.headers["x-from-page"]).toBeUndefined();
    expect(bundle!.commit).toMatchObject({
      committedLevels: ["app", "layout"],
      statusCode: 500,
    });
    expect(created[0].response.statusCode).toBe(500);
  });

  it("layout throw with no layout/app boundary: designation falls back to the app root", async () => {
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
        loader: async ({ response }: any) => {
          response.header("x-from-page", "discarded-with-sibling");
          return { still: "computed" };
        },
      },
    });

    const bundle = await result;
    const { reply } = created[0];

    expect(bundle!.error!.boundary).toEqual({ throwingLevel: "layout", boundaryLevel: "app" });

    // allSettled: the page loader FINISHED and its data is intact —
    expect(bundle!.pageData).toEqual({ still: "computed" });
    // — but its buffer is discarded along with the throwing layer's
    // ("the throwing layer's buffer is discarded with its siblings' below
    // it", request-lifecycle.md:51-52).
    expect(reply.headers["x-from-app"]).toBe("kept");
    expect(reply.headers["x-from-layout"]).toBeUndefined();
    expect(reply.headers["x-from-page"]).toBeUndefined();
    expect(bundle!.commit).toMatchObject({ committedLevels: ["app"], statusCode: 500 });
  });
});

describe("executePageRequest — loader short-circuits", () => {
  it("layout redirect: own buffer commits, page's buffer AND data are discarded, metadata skipped", async () => {
    const pageMetadata = vi.fn(() => ({ title: "never" }));

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
        loader: async ({ response }: any) => {
          response.header("x-from-page", "discarded");
          return { secret: "must not surface" };
        },
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

    // The signalling layer's own buffer commits (its cookie + status)…
    expect(reply.cookies).toEqual([
      expect.objectContaining({ name: "intended-url", value: JSON.stringify("/inline") }),
    ]);
    expect(bundle!.commit).toMatchObject({
      committedLevels: ["app", "layout"],
      statusCode: 302,
    });
    // …the level below is discarded wholesale: buffer AND data.
    expect(reply.headers["x-from-page"]).toBeUndefined();
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
