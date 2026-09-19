import { EventEmitter } from "node:events";
import config from "@mongez/config";
import { Request, Response } from "@warlock.js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePageMetadata } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn(() => ({ metadata: {} })),
}));

vi.mock("./resolve-page-metadata", () => ({ resolvePageMetadata }));
vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
} from "./execute-page-request";
import { PageLoaderTimeoutError } from "./page-loader-timeout-error";

const request = {
  setValidatedData: vi.fn(),
} as unknown as Request;

function route(
  loaders: Partial<Record<"app" | "layout" | "page", PageRouteEntry["triple"]["app"]["loader"]>>,
): PageRouteEntry {
  return {
    path: "/account",
    name: "account",
    triple: {
      app: { loader: loaders.app },
      layout: { loader: loaders.layout },
      page: { loader: loaders.page },
    },
  };
}

/**
 * A `{ request, response }` pair wired to a fake raw Node req/res, so a test
 * can trip `request-abort-signal.ts`'s "aborted" listener the same way a
 * real dropped connection would, without a real HTTP server.
 */
function abortableHttp(): { request: Request; response: Response; rawRequest: EventEmitter } {
  const rawRequest = new EventEmitter();
  const rawResponse = Object.assign(new EventEmitter(), { writableEnded: false });
  const abortableRequest = {
    setValidatedData: vi.fn(),
    baseRequest: { raw: rawRequest },
  } as unknown as Request;
  const abortableResponse = new Response();

  (abortableResponse as unknown as { baseResponse: unknown }).baseResponse = { raw: rawResponse };

  return { request: abortableRequest, response: abortableResponse, rawRequest };
}

beforeEach(() => {
  resolvePageMetadata.mockClear();
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

describe("executePageRequest loaders", () => {
  it("preserves a returned core Response and does not start lower loaders", async () => {
    const calls: string[] = [];
    const terminal = new Response();
    const finish = vi.fn();
    const entry = route({
      app: () => calls.push("app"),
      layout: () => {
        calls.push("layout");
        return terminal;
      },
      page: () => calls.push("page"),
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response: terminal }),
      finish,
    });

    expect(result).toBe(terminal);
    expect(calls).toEqual(["app", "layout"]);
    expect(resolvePageMetadata).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("awaits ordinary loaders root-to-leaf and keeps their values as data", async () => {
    const calls: string[] = [];
    const response = new Response();
    const entry = route({
      app: async () => {
        calls.push("app:start");
        await Promise.resolve();
        calls.push("app:end");
        return { app: true };
      },
      layout: async () => {
        calls.push("layout:start");
        await Promise.resolve();
        calls.push("layout:end");
        return 0;
      },
      page: () => {
        calls.push("page");
        return false;
      },
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    expect(calls).toEqual(["app:start", "app:end", "layout:start", "layout:end", "page"]);
    expect(result).toMatchObject({
      appData: { app: true },
      layoutData: 0,
      pageData: false,
    });
  });
});

describe("executePageRequest ctx.signal", () => {
  it("hands every loader the same AbortSignal instance", async () => {
    const { request: abortRequest, response } = abortableHttp();
    const signals: AbortSignal[] = [];
    const entry = route({
      app: ({ signal }) => {
        signals.push(signal);
      },
      layout: ({ signal }) => {
        signals.push(signal);
      },
      page: ({ signal }) => {
        signals.push(signal);
      },
    });

    await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request: abortRequest, response }),
    });

    expect(signals).toHaveLength(3);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]).toBe(signals[2]);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("does not start the layout or page loader once the request is aborted after the app loader", async () => {
    const { request: abortRequest, response, rawRequest } = abortableHttp();
    const calls: string[] = [];
    const entry = route({
      app: () => {
        calls.push("app");
        // Simulate the client disconnecting while the app loader is
        // already running — the app loader still completes, but the
        // boundary check before the NEXT level must see it.
        rawRequest.emit("aborted");
      },
      layout: () => {
        calls.push("layout");
      },
      page: () => {
        calls.push("page");
      },
    });

    await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request: abortRequest, response }),
    });

    expect(calls).toEqual(["app"]);
  });

  it("discards a cookie a loader queued before the request was abandoned", async () => {
    const { request: abortRequest, response, rawRequest } = abortableHttp();
    const entry = route({
      app: ({ response: bufferedResponse }) => {
        bufferedResponse.cookie("session", "abc");
        rawRequest.emit("aborted");
      },
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request: abortRequest, response }),
    });

    expect((result as { commit?: { cookies: unknown[] } }).commit?.cookies).toEqual([]);
  });

  it("commits a loader's cookie unchanged when the request is never aborted", async () => {
    const { request: abortRequest, response } = abortableHttp();
    const entry = route({
      app: ({ response: bufferedResponse }) => {
        bufferedResponse.cookie("session", "abc");
      },
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request: abortRequest, response }),
    });

    expect((result as { commit?: { cookies: unknown[] } }).commit?.cookies).toEqual([
      { name: "session", value: "abc", options: undefined },
    ]);
  });
});

/**
 * Card `904a04eb`, audit §5.1: a non-deferred loader that never resolves
 * used to hold the request open forever. `web.loaderTimeout` bounds the
 * whole non-deferred loader chain (app → layout → page loaders, plus
 * `validation`) — never a `defer()`-ed value, never the render.
 */
describe("executePageRequest — web.loaderTimeout (card 904a04eb)", () => {
  afterEach(() => {
    config.set("web", {});
  });

  it("fails a hung page loader with PageLoaderTimeoutError (statusCode 504) within a few hundred ms", async () => {
    config.set("web", { loaderTimeout: 50 });
    const entry = route({
      page: () => new Promise(() => undefined),
    });

    const startedAt = Date.now();
    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response: new Response() }),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);

    const bundle = result as { error?: { error: unknown; statusCode?: number } };
    expect(bundle.error?.error).toBeInstanceOf(PageLoaderTimeoutError);
    expect(bundle.error?.statusCode).toBe(504);
  }, 2000);

  it("aborts the request's ctx.signal once the loader timeout fires", async () => {
    config.set("web", { loaderTimeout: 50 });
    let capturedSignal: AbortSignal | undefined;
    const entry = route({
      page: ({ signal }) => {
        capturedSignal = signal;
        return new Promise(() => undefined);
      },
    });

    await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response: new Response() }),
    });

    expect(capturedSignal?.aborted).toBe(true);
  }, 2000);

  it("loaderTimeout: 0 disables the bound — a loader resolving at 100ms still returns its data", async () => {
    config.set("web", { loaderTimeout: 0 });
    const entry = route({
      page: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true }), 100);
        }),
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response: new Response() }),
    });

    expect((result as { pageData?: unknown }).pageData).toEqual({ ok: true });
    expect((result as { error?: unknown }).error).toBeUndefined();
  }, 2000);

  it("does not affect an ordinary fast loader", async () => {
    config.set("web", { loaderTimeout: 50 });
    const entry = route({
      page: () => ({ fast: true }),
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response: new Response() }),
    });

    expect((result as { pageData?: unknown }).pageData).toEqual({ fast: true });
    expect((result as { error?: unknown }).error).toBeUndefined();
  });
});
