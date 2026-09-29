import { Request, Response } from "@warlock.js/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolvePageMetadata as ResolvePageMetadata } from "./resolve-page-metadata";

const { resolvePageMetadata, shared } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn<typeof ResolvePageMetadata>((_input) => ({ metadata: {} })),
  shared: {} as Record<string, unknown>,
}));

vi.mock("./resolve-page-metadata", () => ({ resolvePageMetadata }));
vi.mock("../shared", () => ({
  shared,
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({ ...shared })),
}));

import { connectPageContext, executePageRequest, type PageRouteEntry } from "./execute-page-request";

const site = { key: "blog", host: "blog.test", basePath: "" };

function httpFor(extra: Record<string, unknown>) {
  const request = {
    setValidatedData: vi.fn(),
    method: "GET",
    validated: () => ({}),
    header: () => undefined,
    ...extra,
  } as unknown as Request;

  return { request, response: new Response() };
}

function entryWith(
  name: string,
  observed: unknown[],
  declared?: { path: string; name?: string },
): PageRouteEntry {
  return {
    path: "/posts/7",
    name,
    triple: {
      app: {},
      layout: { loader: (ctx) => observed.push({ level: "layout", route: ctx.route }) },
      page: {
        ...(declared === undefined ? {} : { route: declared }),
        loader: (ctx) => observed.push({ level: "page", route: ctx.route }),
      },
    },
  };
}

beforeEach(() => {
  resolvePageMetadata.mockClear();
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

describe("ctx.route (the matched page's route)", () => {
  it("under sites, page and layout loaders and metadata see the page's declared name", async () => {
    const observed: unknown[] = [];
    const entry = entryWith("posts.show", observed, { path: "/posts/:id", name: "posts.show" });

    await executePageRequest({
      url: "/posts/7",
      routes: [entry],
      matched: { entry, params: { id: "7" } },
      createHttp: () =>
        httpFor({ site, route: { name: "web-site-dispatch-get", path: "/*" }, params: { id: "7" } }),
    });

    const route = { name: "posts.show", path: "/posts/7", params: { id: "7" } };

    expect(observed).toEqual([
      { level: "layout", route },
      { level: "page", route },
    ]);
    expect(resolvePageMetadata.mock.calls[0]?.[0].route).toEqual(route);
  });

  it("under sites, a generated name loses the site prefix the non-sites route never had", async () => {
    const observed: unknown[] = [];
    const entry = entryWith("blog.posts.show", observed);

    await executePageRequest({
      url: "/posts/7",
      routes: [entry],
      matched: { entry, params: {} },
      createHttp: () => httpFor({ site }),
    });

    expect(observed.map((item) => (item as { route: { name: string } }).route.name)).toEqual([
      "posts.show",
      "posts.show",
    ]);
  });

  it("without sites, matches the page's own route", async () => {
    const observed: unknown[] = [];
    const entry = entryWith("posts.show", observed);

    await executePageRequest({
      url: "/posts/7",
      routes: [entry],
      matched: { entry, params: { id: "7" } },
      createHttp: () => httpFor({ route: { name: "posts.show", path: "/posts/7" } }),
    });

    expect(observed.map((item) => (item as { route: unknown }).route)).toEqual([
      { name: "posts.show", path: "/posts/7", params: { id: "7" } },
      { name: "posts.show", path: "/posts/7", params: { id: "7" } },
    ]);
  });

  it("is passed to page actions", async () => {
    const observed: unknown[] = [];
    const entry = entryWith("blog.posts.show", []);

    entry.triple.page.action = (ctx) => observed.push(ctx.route);

    await executePageRequest({
      url: "/posts/7",
      routes: [entry],
      matched: { entry, params: { id: "7" } },
      createHttp: () => httpFor({ site, method: "POST", body: {} }),
    });

    expect(observed).toEqual([{ name: "posts.show", path: "/posts/7", params: { id: "7" } }]);
  });
});
