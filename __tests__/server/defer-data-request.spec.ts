/**
 * STREAMING DEFER, Stage 2 slice S3 — client-navigation DATA request gate.
 *
 * A client navigation to a page that calls `defer()` asks for the JSON
 * representation via `x-warlock-data`. Without `Accept: application/x-ndjson`
 * the fix under test awaits every deferred settlement and inlines the
 * resolved values into `pageData`, omitting `deferred` — mirroring the
 * fully-buffered contract a client that never asks for streaming has always
 * been promised. A rejection reports exactly like an ordinary page-loader
 * throw (`bundle.error`, the same escalation `finishRender` already runs for
 * a synchronous throw).
 */
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Response } from "@warlock.js/core";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import * as App from "./fixtures/root";
import { defer } from "../../src/loaders/defer";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "../../src/server/index";
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
  vi.restoreAllMocks();
});

function pageEntry(path: string, page: Record<string, unknown>): PageRouteEntry {
  return {
    path,
    name: path.replace("/", ""),
    triple: {
      app: App as unknown as PageTripleModule,
      layout: {} as PageTripleModule,
      page: page as unknown as PageTripleModule,
    },
  };
}

describe("data request without Accept: application/x-ndjson — the S3 fallback", () => {
  it("awaits the deferred value, inlines it into pageData, and omits `deferred`", async () => {
    const page = {
      loader: async () => defer({ greeting: "hi", reviews: Promise.resolve({ rating: 5 }) }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, data.greeting),
    };
    const entry = pageEntry("/dashboard", page);
    const http = createCoreHttp({ url: "/dashboard" });

    const rendered = await renderPageRequest("/dashboard", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      dataRequest: true,
      awaitDeferredForDataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    const payload = buildHydrationPayload(rendered.bundle!, "en");
    expect(payload.deferred).toBeUndefined();
    expect(payload.pageData).toEqual({ greeting: "hi", reviews: { rating: 5 } });
    expect(rendered.status).toBe(200);
  });

  it("yields a normal error data response, mirroring an ordinary page-loader throw, when the deferred value rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const page = {
      loader: async () =>
        defer({ greeting: "hi", reviews: Promise.reject(new Error("reviews down")) }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, data.greeting),
    };
    const entry = pageEntry("/broken", page);
    const http = createCoreHttp({ url: "/broken" });

    const rendered = await renderPageRequest("/broken", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      dataRequest: true,
      awaitDeferredForDataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    // The SAME shape an ordinary synchronous page-loader throw produces: a
    // 500, and `bundle.error` designating the page (or higher) boundary —
    // `create-page-route-handler.ts` sends this exact bundle as the data
    // response's JSON body, unchanged from today's throw path.
    expect(rendered.status).toBe(500);
    expect(rendered.bundle?.error).toBeDefined();
    expect(rendered.bundle?.deferredKeys).toBeUndefined();
  });

  it("a page with no defer() is unchanged", async () => {
    const page = {
      loader: async () => ({ greeting: "hi" }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, data.greeting),
    };
    const entry = pageEntry("/plain", page);
    const http = createCoreHttp({ url: "/plain" });

    const rendered = await renderPageRequest("/plain", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      dataRequest: true,
      awaitDeferredForDataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.status).toBe(200);
    expect(rendered.bundle?.deferredKeys).toBeUndefined();
    expect(buildHydrationPayload(rendered.bundle!, "en").pageData).toEqual({ greeting: "hi" });
  });
});
