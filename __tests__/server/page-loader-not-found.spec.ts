import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { parse } from "devalue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpContext, Router } from "@warlock.js/core";
import {
  createPageRouteHandler,
  type PageModuleLoader,
  type PageRouteHandler,
} from "../../src/server/create-page-route-handler";
import { connectPageContext, type PageContextRunner } from "../../src/server/index";
import { notFoundPageHandlerOptions } from "../../src/server/not-found-handler-options";
import {
  installPageRoutes,
  type InstallPageRoutesOptions,
} from "../../src/server/install-page-routes";
import { installPageRoutesFromManifest } from "../../src/server/install-page-routes-from-manifest";
import { createNotFoundRouteHandler, NOT_FOUND_ROUTE_PATH } from "../../src/server/not-found-page";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "../../src/server/__fixtures__/core-http";
import * as App from "./fixtures/root";

/**
 * A LOADER `notFound()` on a full-document request, asserted at the wire
 * (card c20dbfa2).
 *
 * The defect: `return response.notFound()` from a page, layout or app loader
 * answered a browser with 404, `text/html` and ZERO bytes — no `<html>`, no
 * `404.page.tsx`, no noindex — while an UNMATCHED URL already rendered the
 * application's not-found page. A client navigation to the same URL falls
 * back to a full load on the 404 data response, so the empty body landed the
 * visitor on the browser's own error screen.
 *
 * The ruling: the document representation of a loader `notFound()` is the
 * SAME document the unmatched-route handler renders — the app's
 * `404.page.tsx` through the not-found route's own handler, or the framework
 * fallback when there is none. The redirect short-circuit and the data wire
 * are pinned unchanged alongside it.
 */

const APP_FILE = "/fixtures/web/root.tsx";
const LAYOUT_FILE = "/fixtures/web/account.layout.tsx";
const PAGE_FILE = "/fixtures/web/product.page.tsx";
const NOT_FOUND_FILE = "/fixtures/web/404.page.tsx";
const NOT_FOUND_STYLESHEET = "/assets/not-found.css";
const PAGE_URL = "/products/missing";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
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

/** The application's own `404.page.tsx`. */
const notFoundPage = {
  default: () => createElement("main", { "data-testid": "app-not-found" }, "No such product"),
  metadata: { title: "Not found" },
};

const missingPage = {
  loader: async ({ response }: any) => response.notFound(),
  default: () => createElement("main", null, "the real page"),
};

const passthroughLayout = {
  default: ({ children }: { children?: ReactNode }) => createElement("section", null, children),
};

function moduleLoader(modules: Record<string, unknown>): PageModuleLoader {
  return async (moduleId: string) => {
    const module = modules[moduleId];

    if (!module) throw new Error(`fake loader: nothing registered for "${moduleId}"`);

    return module;
  };
}

/** The not-found route's page handler, built exactly as both installers build it. */
function notFoundRenderer(loadModule: PageModuleLoader): PageRouteHandler {
  return createPageRouteHandler({
    ...notFoundPageHandlerOptions({
      appFile: APP_FILE,
      pageFile: NOT_FOUND_FILE,
      loadModule,
      stylesheetUrls: [NOT_FOUND_STYLESHEET],
    }),
    httpServer: undefined,
  });
}

type WireResult = {
  status: number;
  body: string;
  headers: Record<string, unknown>;
  cookies: string[];
  sendCalls: number;
};

/**
 * Drive ONE request through `handler` and read back what reached the wire —
 * a streamed document's bytes from `raw`, a buffered one from `send()`.
 */
async function toWire(
  handler: PageRouteHandler,
  url: string,
  headers: Record<string, string> = { accept: "text/html" },
): Promise<WireResult> {
  const http = createCoreHttp({ url, headers });
  const chunks: Buffer[] = [];

  http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

  const send = vi.spyOn(http.response, "send");

  await handler({ request: http.request, response: http.response } as unknown as HttpContext);

  const streamed = Buffer.concat(chunks).toString("utf8");
  const buffered = http.reply.payloads
    .filter((payload): payload is string => typeof payload === "string")
    .join("");

  return {
    status: http.reply.statusCode,
    body: streamed + buffered,
    headers: http.reply.appliedHeaders,
    cookies: http.reply.cookies.map((cookie) => cookie.name),
    sendCalls: send.mock.calls.length,
  };
}

function pageHandler(options: {
  page: unknown;
  layout?: unknown;
  withNotFoundPage?: boolean;
}): PageRouteHandler {
  const loadModule = moduleLoader({
    [APP_FILE]: App,
    [PAGE_FILE]: options.page,
    [NOT_FOUND_FILE]: notFoundPage,
    ...(options.layout === undefined ? {} : { [LAYOUT_FILE]: options.layout }),
  });

  const notFound = options.withNotFoundPage === false ? undefined : notFoundRenderer(loadModule);

  return createPageRouteHandler({
    path: PAGE_URL,
    name: "products.show",
    appFile: APP_FILE,
    pageFile: PAGE_FILE,
    layoutFile: options.layout === undefined ? undefined : LAYOUT_FILE,
    loadModule,
    renderNotFound: () => notFound,
    httpServer: undefined,
  });
}

function expectAppNotFoundDocument(wire: WireResult): void {
  expect(wire.status).toBe(404);
  expect(wire.body.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(wire.body).toContain('data-testid="app-not-found"');
  expect(wire.body).toContain("No such product");
  expect(wire.body).not.toContain("the real page");
  expect(wire.body).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
  expect(wire.body).toContain(`href="${NOT_FOUND_STYLESHEET}"`);
  expect(wire.headers["cache-control"]).toBe("no-store");
}

describe("a loader notFound() on a FULL-DOCUMENT request renders the not-found page", () => {
  it("control: the UNMATCHED-route handler renders the same 404 document", async () => {
    const loadModule = moduleLoader({ [APP_FILE]: App, [NOT_FOUND_FILE]: notFoundPage });
    const unmatched = createNotFoundRouteHandler({ renderPage: notFoundRenderer(loadModule) });

    expectAppNotFoundDocument(await toWire(unmatched, "/no/such/url"));
  });

  it("page-loader notFound → 404, the app's 404.page.tsx, doctype, noindex, no-store", async () => {
    expectAppNotFoundDocument(await toWire(pageHandler({ page: missingPage }), PAGE_URL));
  });

  it("layout-loader notFound → the same 404 document", async () => {
    const missingLayout = {
      ...passthroughLayout,
      loader: async ({ response }: any) => response.notFound(),
    };
    const page = { loader: async () => ({ ok: true }), default: missingPage.default };

    expectAppNotFoundDocument(await toWire(pageHandler({ page, layout: missingLayout }), PAGE_URL));
  });

  it("a crawler gets the same 404 document", async () => {
    const wire = await toWire(pageHandler({ page: missingPage }), PAGE_URL, {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    });

    expectAppNotFoundDocument(wire);
  });

  it("carries the loader's committed cookie onto the 404 document", async () => {
    const page = {
      loader: async ({ response }: any) => {
        response.cookie("last-seen", PAGE_URL);
        return response.notFound();
      },
      default: missingPage.default,
    };
    const wire = await toWire(pageHandler({ page }), PAGE_URL);

    expectAppNotFoundDocument(wire);
    expect(wire.cookies).toContain("last-seen");
  });

  it("with NO 404.page.tsx → the framework fallback, still a non-empty 404 document", async () => {
    const wire = await toWire(
      pageHandler({ page: missingPage, withNotFoundPage: false }),
      PAGE_URL,
    );

    expect(wire.status).toBe(404);
    expect(wire.body.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(wire.body).toContain("<h1>404</h1>");
    expect(wire.body).toContain('<meta name="robots" content="noindex">');
    expect(wire.body).not.toContain("the real page");
    expect(wire.headers["content-type"]).toContain("text/html");
    expect(wire.headers["cache-control"]).toBe("no-store");
    expect(wire.sendCalls).toBe(1);
  });
});

describe("the other short-circuit shapes are unchanged", () => {
  it("a loader redirect keeps its empty body and its Location", async () => {
    const movedPage = {
      loader: async ({ response }: any) => response.redirect("/products/moved"),
      default: missingPage.default,
    };

    const wire = await toWire(pageHandler({ page: movedPage }), PAGE_URL);

    expect(wire.status).toBe(302);
    expect(wire.headers.location).toBe("/products/moved");
    expect(wire.body).toBe("");
    expect(wire.body).not.toContain("app-not-found");
  });

  it("a DATA request keeps its 404 payload wire: status 404, the hydration payload, no document", async () => {
    const wire = await toWire(pageHandler({ page: missingPage }), PAGE_URL, {
      "x-warlock-data": "1",
    });

    expect(wire.status).toBe(404);
    expect(String(wire.headers["content-type"])).toContain("application/json");
    expect(wire.body).not.toContain("<html");
    expect(wire.body).not.toContain("app-not-found");

    const payload = parse(wire.body) as Record<string, unknown>;

    expect(payload.name).toBe("products.show");
    expect(wire.sendCalls).toBe(1);
  });
});

/**
 * The same behaviour through each INSTALLER — the proof that a page route as
 * the application actually gets it is wired to the app's `404.page.tsx`. A
 * handler-level spec above cannot see a missing `renderNotFound` on the
 * installed handler; without that wiring these fall back to the framework
 * document and never contain the app's markup.
 */
type InstalledRoute = { path: string; handler: PageRouteHandler };

function recordingRouter() {
  const pages: InstalledRoute[] = [];
  const notFound: InstalledRoute[] = [];

  const router = {
    get(path: string, handler: PageRouteHandler) {
      (path === NOT_FOUND_ROUTE_PATH ? notFound : pages).push({ path, handler });

      return router;
    },
    async withSourceFile<T>(_file: string, callback: () => T | Promise<T>) {
      return callback();
    },
    list: () => [],
  };

  return { router: router as unknown as Router, pages, notFound };
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

const routedMissingPage = { ...missingPage, route: PAGE_URL };

describe("a page installed by each installer renders the APP's 404.page.tsx on a loader notFound()", () => {
  it("production — installPageRoutesFromManifest", async () => {
    const { router, pages, notFound } = recordingRouter();

    installPageRoutesFromManifest({
      router,
      manifest: {
        app: { module: App, sourceFile: "src/web/root.tsx" },
        pages: [
          { module: routedMissingPage, sourceFile: "src/web/product.page.tsx", layouts: [] },
          { module: notFoundPage, sourceFile: "src/web/404.page.tsx", layouts: [] },
        ],
      },
      createHandler: (options) => createPageRouteHandler({ ...options, httpServer: undefined }),
    });

    expect(notFound).toHaveLength(1);

    const page = pages.find((route) => route.path === PAGE_URL);
    const wire = await toWire(page!.handler, PAGE_URL);

    expect(wire.status).toBe(404);
    expect(wire.body).toContain('data-testid="app-not-found"');
    expect(wire.body).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
  });

  it("dev — installPageRoutes", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-loader-not-found-"));
    temporaryDirectories.push(appRoot);

    const appSrcRoot = path.join(appRoot, "src");
    const webDir = path.join(appSrcRoot, "web");
    const appFile = path.join(webDir, "root.tsx");
    const pageFile = path.join(webDir, "product.page.tsx");
    const notFoundFile = path.join(webDir, "404.page.tsx");

    fs.mkdirSync(webDir, { recursive: true });

    for (const file of [appFile, pageFile, notFoundFile]) fs.writeFileSync(file, "", "utf-8");

    const modules: Record<string, unknown> = {
      [appFile]: App,
      [pageFile]: routedMissingPage,
      [notFoundFile]: notFoundPage,
    };
    const vite = {
      ssrLoadModule: async (id: string) => {
        if (modules[id] === undefined) throw new Error(`fake vite: nothing for "${id}"`);

        return modules[id];
      },
    } as unknown as InstallPageRoutesOptions["vite"];
    const { router, pages, notFound } = recordingRouter();

    await installPageRoutes({
      router,
      vite,
      appSrcRoot,
      appFile,
      httpServer: { addHook: vi.fn() } as never,
    });

    expect(notFound).toHaveLength(1);

    const page = pages.find((route) => route.path === PAGE_URL);
    const wire = await toWire(page!.handler, PAGE_URL);

    expect(wire.status).toBe(404);
    expect(wire.body).toContain('data-testid="app-not-found"');
    expect(wire.body).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
  });
});
