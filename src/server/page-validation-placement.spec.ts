import { Response, type Request } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
  type PipelineLoader,
} from "./execute-page-request";
import type { PageDataBundle } from "./execute-page-request.types";

/**
 * Card 5056fb56: a page's top-level `validation` export runs at the front of
 * the PAGE level's own turn — after the app and layout loaders, before the
 * page loader. Observed, not asserted: each step records its turn (the
 * validation step through a spy on `v.validate`, the one call the pipeline
 * makes for it), and the recorded sequence is what the specs check.
 */

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createHttp(query: Record<string, string>) {
  let validatedData: Record<string, unknown> = {};
  const response = new Response();
  // No live Fastify reply behind this core `Response`: the committed
  // `Location` header of the redirect case has nowhere to go, so it is
  // swallowed here — the bundle already carries it on `commit`.
  vi.spyOn(response, "header").mockReturnValue(response);
  const request = {
    nonce: undefined,
    locale: "en",
    params: {},
    query,
    setValidatedData(data: Record<string, unknown>) {
      validatedData = data;
    },
    validated() {
      return validatedData;
    },
  } as unknown as Request;

  return { request, response };
}

function recordValidation(order: string[]): void {
  const validate = v.validate.bind(v);

  vi.spyOn(v, "validate").mockImplementation(async (...args: Parameters<typeof v.validate>) => {
    order.push("validation");
    return validate(...args);
  });
}

function entry(order: string[], layoutLoader: PipelineLoader): PageRouteEntry {
  return {
    path: "/posts",
    name: "posts.list",
    triple: {
      app: {
        loader: () => {
          order.push("app");
          return { appName: "Blog" };
        },
      },
      layout: { loader: layoutLoader },
      page: {
        route: { path: "/posts" },
        validation: { query: v.object({ page: v.int().coerce() }) },
        loader: () => {
          order.push("page");
          return { posts: [] };
        },
      },
    },
  };
}

async function run(routeEntry: PageRouteEntry, query: Record<string, string>) {
  const { request, response } = createHttp(query);

  return (await executePageRequest({
    url: `/posts?${new URLSearchParams(query).toString()}`,
    routes: [routeEntry],
    createHttp: () => ({ request, response }),
  })) as PageDataBundle;
}

describe("page validation placement — the page level's own turn (5056fb56)", () => {
  it("runs after the app and layout loaders and before the page loader", async () => {
    const order: string[] = [];
    recordValidation(order);

    const bundle = await run(
      entry(order, () => {
        order.push("layout");
        return { x: "layout-data" };
      }),
      { page: "2" },
    );

    expect(bundle.shortCircuit).toBeUndefined();
    expect(order).toEqual(["app", "layout", "validation", "page"]);
  });

  it("a failure still stops the page loader, after the ancestors' loaders already ran", async () => {
    const order: string[] = [];
    recordValidation(order);

    const bundle = await run(
      entry(order, () => {
        order.push("layout");
        return { x: "layout-data" };
      }),
      { page: "not-a-number" },
    );

    expect(order).toEqual(["app", "layout", "validation"]);
    expect(bundle.shortCircuit).toMatchObject({ stage: "validation", status: 400 });
    expect(bundle.layoutData).toEqual({ x: "layout-data" });
    expect(bundle.appData).toEqual({ appName: "Blog" });
  });

  it("a layout loader redirect still wins: validation never runs", async () => {
    const order: string[] = [];
    recordValidation(order);

    const bundle = await run(
      entry(order, ({ response }) => {
        order.push("layout");
        return response.redirect("/login");
      }),
      // Invalid on purpose — a validation that ran would have answered 400.
      { page: "not-a-number" },
    );

    expect(order).toEqual(["app", "layout"]);
    expect(bundle.shortCircuit).toMatchObject({
      stage: "loaders",
      level: "layout",
      kind: "redirect",
      url: "/login",
    });
    expect(bundle.error).toBeUndefined();
  });

  it("a layout loader throw still wins: validation never runs", async () => {
    const order: string[] = [];
    recordValidation(order);

    const bundle = await run(
      entry(order, () => {
        order.push("layout");
        throw new Error("layout failed");
      }),
      { page: "not-a-number" },
    );

    expect(order).toEqual(["app", "layout"]);
    expect(bundle.shortCircuit).toBeUndefined();
    expect(bundle.error?.boundary.throwingLevel).toBe("layout");
  });
});
