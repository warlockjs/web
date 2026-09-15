/**
 * CRAWLER MODE — Stage 1 point 6 (`releases/v5.12-streaming-design.md`).
 *
 * A crawler that never runs the defer-bootstrap script would index a
 * streamed shell forever missing its deferred sections — it has no chance to
 * observe a later chunk the way a browser does. Wiring `web.streaming.crawlers`
 * makes a detected crawler's FULL-DOCUMENT request reuse the data-request
 * fallback's await-and-inline path (`defer-data-request.spec.ts`) instead:
 * every deferred value settles and is inlined before the first byte.
 *
 * Real core `Request`/`Response` throughout, same construction as
 * `defer-streaming.spec.ts` in this directory.
 */
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Response, setConfig, type HttpContext } from "@warlock.js/core";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import * as App from "./fixtures/root";
import * as layout from "./fixtures/layout";
import { defer } from "../../src/loaders/defer";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "../../src/server/index";
import { createPageRouteHandler } from "../../src/server/create-page-route-handler";
import { buildHydrationPayload } from "../../src/server/build-hydration-payload";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";

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

afterEach(() => {
  setConfig("web", {});
  vi.restoreAllMocks();
});

function pageEntry(path: string, page: Record<string, unknown>): PageRouteEntry {
  return {
    path,
    name: path.replace("/", ""),
    triple: {
      app: App as unknown as PageTripleModule,
      layout: layout as unknown as PageTripleModule,
      page: page as unknown as PageTripleModule,
    },
  };
}

/** Flush every pending microtask AND macrotask — same helper `defer-streaming.spec.ts` uses. */
async function flushAsyncWork(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("renderPageRequest — crawler: true (a detected crawler's document request)", () => {
  it("inlines the resolved deferred value, writes no bytes before it settles, and carries no defer wire-shape", async () => {
    let releaseReviews!: (value: unknown) => void;
    const reviews = new Promise((resolve) => {
      releaseReviews = resolve;
    });

    const page = {
      loader: async () => defer({ greeting: "Hello crawler", reviews }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, createElement("h1", null, data.greeting)),
    };
    const entry = pageEntry("/dashboard", page);
    const http = createCoreHttp({ url: "/dashboard", headers: { "user-agent": "Googlebot/2.1" } });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    const renderedPromise = renderPageRequest("/dashboard", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      crawler: true,
    });

    // Give the deferred value every chance to settle prematurely — it must
    // not, so nothing should have reached the wire yet by the time
    // `renderPageRequest` itself is still pending.
    await flushAsyncWork();
    expect(chunks).toHaveLength(0);

    releaseReviews({ id: 1, rating: 5 });
    const rendered = await renderedPromise;

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");
    expect(rendered.pipeableStream).toBeDefined();
    expect(rendered.usesDefer).toBe(true);

    http.response.setContentType("text/html");
    http.response.setStatusCode(rendered.status);
    await http.response.streamReact(rendered.pipeableStream!);

    const wireHtml = Buffer.concat(chunks).toString("utf8");

    expect(wireHtml).toContain("Hello crawler");
    expect(wireHtml).not.toContain("__WARLOCK_DEFER__");
    expect(wireHtml).not.toContain("DEFER_BOOTSTRAP");

    const payload = buildHydrationPayload(rendered.bundle!, "en");
    expect(payload.deferred).toBeUndefined();
    expect(payload.pageData).toEqual({ greeting: "Hello crawler", reviews: { id: 1, rating: 5 } });
    expect(JSON.stringify(payload)).not.toContain("__WARLOCK_DEFER__");
  });

  it("renders the error page with the failure's real status when a deferred value rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const page = {
      loader: async () =>
        defer({ greeting: "hi", reviews: Promise.reject(new Error("reviews down")) }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, data.greeting),
    };
    const entry = pageEntry("/broken", page);
    const http = createCoreHttp({ url: "/broken", headers: { "user-agent": "Googlebot/2.1" } });

    const rendered = await renderPageRequest("/broken", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      crawler: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    // Same shape an ordinary synchronous page-loader throw produces
    // (`defer-data-request.spec.ts`'s equivalent assertion for a data
    // request) — nothing had flushed yet, so the ordinary boundary/status
    // escalation is exactly right for a document too.
    expect(rendered.status).toBe(500);
    expect(rendered.bundle?.error).toBeDefined();
    expect(rendered.bundle?.deferredKeys).toBeUndefined();
    expect(rendered.pipeableStream).toBeDefined();
  });

  it("a page with no defer() is unaffected", async () => {
    const page = {
      loader: async () => ({ greeting: "hi" }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, data.greeting),
    };
    const entry = pageEntry("/plain", page);
    const http = createCoreHttp({ url: "/plain", headers: { "user-agent": "Googlebot/2.1" } });

    const rendered = await renderPageRequest("/plain", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      crawler: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");
    expect(rendered.status).toBe(200);
    expect(rendered.usesDefer).toBe(false);
  });
});

describe("createPageRouteHandler — crawler wiring end to end", () => {
  const APP_FILE = "/fixtures/root.tsx";
  const LAYOUT_FILE = "/fixtures/layout.tsx";
  const PAGE_FILE = "/fixtures/dashboard.page.tsx";

  function handlerFor(page: Record<string, unknown>) {
    return createPageRouteHandler({
      path: "/dashboard",
      name: "dashboard",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      layoutFile: LAYOUT_FILE,
      loadModule: async (moduleId: string) => {
        if (moduleId === APP_FILE) return App;
        if (moduleId === LAYOUT_FILE) return layout;
        if (moduleId === PAGE_FILE) return page;
        throw new Error(`unexpected module id ${moduleId}`);
      },
      httpServer: undefined,
    });
  }

  function deferPage() {
    return {
      loader: async () =>
        defer({ greeting: "Hello streaming", reviews: Promise.resolve({ id: 1, rating: 5 }) }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, createElement("h1", null, data.greeting)),
    };
  }

  function plainPage() {
    return {
      loader: async () => ({ greeting: "Hello plain" }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, createElement("h1", null, data.greeting)),
    };
  }

  it("Googlebot on a defer() page receives the fully resolved document and Vary: User-Agent", async () => {
    const handler = handlerFor(deferPage());
    const http = createCoreHttp({
      url: "/dashboard",
      headers: { "user-agent": "Googlebot/2.1" },
    });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await handler({ request: http.request, response: http.response } as HttpContext);

    const wireHtml = Buffer.concat(chunks).toString("utf8");
    expect(wireHtml).toContain("Hello streaming");
    expect(wireHtml).not.toContain("__WARLOCK_DEFER__");
    expect(http.reply.appliedHeaders["vary"]).toBe("User-Agent");
  });

  it("an ordinary browser on the same page streams as today, unchanged", async () => {
    const handler = handlerFor(deferPage());
    const http = createCoreHttp({
      url: "/dashboard",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0",
      },
    });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await handler({ request: http.request, response: http.response } as HttpContext);

    const wireHtml = Buffer.concat(chunks).toString("utf8");
    expect(wireHtml).toContain("__WARLOCK_DEFER__");
    expect(http.reply.appliedHeaders["vary"]).toBe("User-Agent");
  });

  it("web.streaming.crawlers: false streams even for Googlebot", async () => {
    setConfig("web", { streaming: { crawlers: false } });

    const handler = handlerFor(deferPage());
    const http = createCoreHttp({
      url: "/dashboard",
      headers: { "user-agent": "Googlebot/2.1" },
    });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await handler({ request: http.request, response: http.response } as HttpContext);

    const wireHtml = Buffer.concat(chunks).toString("utf8");
    expect(wireHtml).toContain("__WARLOCK_DEFER__");
  });

  it("a custom detect() wins over the user-agent list", async () => {
    setConfig("web", { streaming: { crawlers: { detect: () => true } } });

    const handler = handlerFor(deferPage());
    const http = createCoreHttp({
      url: "/dashboard",
      headers: { "user-agent": "definitely-not-a-crawler/1.0" },
    });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await handler({ request: http.request, response: http.response } as HttpContext);

    const wireHtml = Buffer.concat(chunks).toString("utf8");
    expect(wireHtml).toContain("Hello streaming");
    expect(wireHtml).not.toContain("__WARLOCK_DEFER__");
  });

  it("a plain page (no defer()) never carries Vary, for any user agent", async () => {
    const handler = handlerFor(plainPage());
    const http = createCoreHttp({
      url: "/dashboard",
      headers: { "user-agent": "Googlebot/2.1" },
    });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await handler({ request: http.request, response: http.response } as HttpContext);

    const wireHtml = Buffer.concat(chunks).toString("utf8");
    expect(wireHtml).toContain("Hello plain");
    expect(http.reply.appliedHeaders["vary"]).toBeUndefined();
  });
});
