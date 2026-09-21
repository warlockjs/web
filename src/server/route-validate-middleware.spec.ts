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
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import { InvalidPageModuleConfigError } from "./normalize-page-module";
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

/** A fake request with the validation surface its callers read. */
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

// ---------------------------------------------------------------------------
// Red control — three observations against ONE page: valid input reaches the
// loader typed (innocent), invalid input produces the 400 error page carrying
// the failure (guilty), and — with route.validate removed — the same bad
// input flows through to the page unchecked (the defect returning).
// ---------------------------------------------------------------------------

describe("config.route middleware diagnostic", () => {
  it("refuses an unknown nested middleware key before any request", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-route-middleware-"));
    const appSrcRoot = path.join(appRoot, "src");
    const pageFile = path.join(appSrcRoot, "web", "orders.page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "", "utf-8");

    const vite = {
      ssrLoadModule: vi.fn(async (id: string) =>
        /[\\/]web[\\/]root\.tsx$/.test(id)
          ? { default: (): null => null }
          : {
              config: { route: { path: "/orders", middleware: [() => undefined] } },
              default: (): null => null,
            },
      ),
    } as unknown as InstallPageRoutesOptions["vite"];
    const options: InstallPageRoutesOptions = {
      router: {} as InstallPageRoutesOptions["router"],
      vite,
      appSrcRoot,
      appFile: path.join(appSrcRoot, "web", "root.tsx"),
    };

    try {
      await expect(installPageRoutes(options)).rejects.toBeInstanceOf(InvalidPageModuleConfigError);
      await expect(installPageRoutes(options)).rejects.toThrow(pageFile);
      await expect(installPageRoutes(options)).rejects.toThrow(
        "config.route has unknown key(s): middleware.",
      );
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });
});

const schema = v.object({
  id: v.string().minLength(2),
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
        },
        ...(withValidation ? { validation: { schema } } : {}),
        loader: ({ request }) => {
          const id = withValidation
            ? (request.validated() as { id?: unknown }).id
            : request.params?.id;
          loaderSpy(id);
          return { id };
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

describe("page.validation internal pipeline control", () => {
  it("valid input reaches the loader through request.validated()", async () => {
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

  it("refuses an unknown nested validate key in config.route", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-route-validation-"));
    const appSrcRoot = path.join(appRoot, "src");
    const pageFile = path.join(appSrcRoot, "web", "products.page.tsx");
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(pageFile, "", "utf-8");

    const vite = {
      ssrLoadModule: vi.fn(async (id: string) =>
        /[\\/]web[\\/]root\.tsx$/.test(id)
          ? { default: (): null => null }
          : {
              config: { route: { path: "/products/:id", validate: schema } },
              default: (): null => null,
            },
      ),
    } as unknown as InstallPageRoutesOptions["vite"];
    const options: InstallPageRoutesOptions = {
      router: {} as InstallPageRoutesOptions["router"],
      vite,
      appSrcRoot,
      appFile: path.join(appSrcRoot, "web", "root.tsx"),
    };

    try {
      await expect(installPageRoutes(options)).rejects.toBeInstanceOf(InvalidPageModuleConfigError);
      await expect(installPageRoutes(options)).rejects.toThrow(pageFile);
      await expect(installPageRoutes(options)).rejects.toThrow(
        "config.route has unknown key(s): validate.",
      );
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });

  it("without page.validation, bad input reaches the page unchecked", async () => {
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
