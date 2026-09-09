import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Response, type Request } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePageMetadata } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn(() => ({ metadata: {} })),
}));

vi.mock("./resolve-page-metadata", async () => {
  const actual =
    await vi.importActual<typeof import("./resolve-page-metadata")>("./resolve-page-metadata");
  return { ...actual, resolvePageMetadata };
});
vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
} from "./execute-page-request";
import {
  installPageRoutes,
  RouteMiddlewareRemovedError,
  type InstallPageRoutesOptions,
} from "./install-page-routes";
import { renderPageRequest } from "./render-page";
import type { ErrorPageModule } from "./error-page";

beforeEach(() => {
  resolvePageMetadata.mockClear();
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

/** A fake request with the surface `route.validate` and its callers read. */
function createHttp(params: Record<string, string>, query: Record<string, string>) {
  let validatedData: Record<string, unknown> = {};
  const response = new Response();
  const request = {
    nonce: undefined,
    locale: "en",
    params,
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

// ---------------------------------------------------------------------------
// Ordering — OBSERVED, not asserted: a layout and a page each record their
// turn, and the recorded sequence is what the test checks.
// ---------------------------------------------------------------------------

describe("page middleware — observed ordering", () => {
  it("runs every layout's middleware before the page's own top-level export, closest to the loader", async () => {
    const order: string[] = [];
    const entry: PageRouteEntry = {
      path: "/orders/:id",
      name: "orders.details",
      triple: {
        app: {},
        layout: {
          middleware: [
            () => {
              order.push("layout");
            },
          ],
        },
        page: {
          route: { path: "/orders/:id" },
          middleware: [
            () => {
              order.push("page");
            },
          ],
          loader: () => {
            order.push("loader");
          },
        },
      },
    };

    const { request, response } = createHttp({ id: "1" }, {});

    await executePageRequest({
      url: "/orders/1",
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    expect(order).toEqual(["layout", "page", "loader"]);
  });
});

describe("route.middleware — withdrawn, fails loudly instead of being dropped", () => {
  it.skip("the runtime diagnostic moved to installation", async () => {
    const entry: PageRouteEntry = {
      path: "/orders/:id",
      name: "orders.details",
      triple: {
        app: {},
        layout: {},
        page: {
          route: {
            path: "/orders/:id",
            // @ts-expect-error — `route.middleware` was withdrawn; this is the shape a
            // pre-5.6.0-migration page module still exports.
            middleware: [() => undefined],
          },
        },
      },
    };

    const { request, response } = createHttp({ id: "1" }, {});

    await expect(
      executePageRequest({
        url: "/orders/1",
        routes: [entry],
        createHttp: () => ({ request, response }),
      }),
    ).rejects.toThrow(RouteMiddlewareRemovedError);

    await expect(
      executePageRequest({
        url: "/orders/1",
        routes: [entry],
        createHttp: () => ({ request, response }),
      }),
    ).rejects.toThrow(/orders\.details.*\/orders\/:id.*top-level `middleware` export/s);
  });
});

// ---------------------------------------------------------------------------
// Red control — three observations against ONE page: valid input reaches the
// loader typed (innocent), invalid input produces the 400 error page carrying
// the failure (guilty), and — with route.validate removed — the same bad
// input flows through to the page unchecked (the defect returning).
// ---------------------------------------------------------------------------

describe("route.middleware boot diagnostic", () => {
  it("names the page source file and replacement export before any request", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-route-middleware-"));
    const appSrcRoot = path.join(appRoot, "src");
    const pageFile = path.join(appSrcRoot, "web", "orders.page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "", "utf-8");

    const vite = {
      ssrLoadModule: vi.fn(async () => ({
        route: { path: "/orders", middleware: [() => undefined] },
      })),
    } as unknown as InstallPageRoutesOptions["vite"];
    const options: InstallPageRoutesOptions = {
      router: {} as InstallPageRoutesOptions["router"],
      vite,
      appSrcRoot,
      appFile: path.join(appSrcRoot, "web", "root.tsx"),
    };

    try {
      await expect(installPageRoutes(options)).rejects.toThrow(RouteMiddlewareRemovedError);
      await expect(installPageRoutes(options)).rejects.toThrow(
        `"${pageFile}" declares \`route.middleware\`, which no longer runs — it was withdrawn after 5.6.0. ` +
          "Move it to the page's own top-level `middleware` export instead: `export const middleware = [...]`.",
      );
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });
});

const schema = v.object({
  params: v.object({ id: v.string().minLength(2) }),
  query: v.object({}).optional(),
});

function pageEntry(withValidation: boolean, loaderSpy: (id: unknown) => void): PageRouteEntry {
  return {
    path: "/products/:id",
    name: "products.details",
    triple: {
      app: {},
      layout: {},
      page: {
        route: {
          path: "/products/:id",
          ...(withValidation ? { validate: schema } : {}),
        },
        loader: ({ request }) => {
          loaderSpy(
            (request.validated() as { params?: { id?: unknown } }).params?.id ?? request.params?.id,
          );
          return { id: (request.validated() as { params?: { id?: unknown } }).params?.id };
        },
        default: () => createElement("main", {}, "ok"),
      },
    },
  };
}

function fakeErrorPageModule(): ErrorPageModule {
  return {
    default: ({ error }: { error: unknown }) =>
      createElement("main", { role: "alert" }, (error as Error).message),
  };
}

describe("route.validate — red control", () => {
  it("INNOCENT: valid input reaches the loader typed, under request.validated().params", async () => {
    const loaderSpy = vi.fn();
    const { request, response } = createHttp({ id: "42" }, {});

    const rendered = await renderPageRequest("/products/42", {
      routes: [pageEntry(true, loaderSpy)],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(loaderSpy).toHaveBeenCalledWith("42");
    expect(rendered.status).toBe(200);
    expect(rendered.html).toContain("ok");
  });

  it("GUILTY: invalid input renders the error page at 400, carrying the failure", async () => {
    const loaderSpy = vi.fn();
    // "x" fails `minLength(2)`.
    const { request, response } = createHttp({ id: "x" }, {});

    const rendered = await renderPageRequest("/products/x", {
      routes: [pageEntry(true, loaderSpy)],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    // The real status line a client would receive.
    expect(rendered.status).toBe(400);
    // The real rendered body — the error page, not raw JSON.
    expect(rendered.html).toContain("id");
    expect(rendered.html).toContain('role="alert"');
    // The loader never ran on bad input.
    expect(loaderSpy).not.toHaveBeenCalled();
    // The SAME 400 travels in the `_loader` wire envelope (bundle.errorPage.status).
    expect(rendered.bundle?.errorPage?.status).toBe(400);
  });

  it("THE DEFECT RETURNING: with route.validate removed, bad input reaches the page unchecked", async () => {
    const loaderSpy = vi.fn();
    const { request, response } = createHttp({ id: "x" }, {});

    const rendered = await renderPageRequest("/products/x", {
      routes: [pageEntry(false, loaderSpy)],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.status).toBe(200);
    // "x" reached the page — nothing rejected it.
    expect(loaderSpy).toHaveBeenCalledWith("x");
  });
});
