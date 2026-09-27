import {
  registerTracingHooks,
  resetTracingConfigForTests,
  Response,
  type Request,
  type TracingPhaseInfo,
} from "@warlock.js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renderPageRequest, resolvePageCacheHitOrMiss } = vi.hoisted(() => ({
  renderPageRequest: vi.fn(),
  resolvePageCacheHitOrMiss: vi.fn(),
}));

vi.mock("./render-page", () => ({ renderPageRequest }));
vi.mock("./page-route-handler/serve-page-cache-hit", () => ({ resolvePageCacheHitOrMiss }));

import { createPageRouteHandler } from "./create-page-route-handler";
import { createDeferredSettlement } from "./defer-settlement";
import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
} from "./execute-page-request";

const phases: TracingPhaseInfo[] = [];
let unregister: (() => void) | undefined;

/**
 * Same header/cookie surface `page-cache-eligibility.ts`'s
 * `looksAuthenticated` and `page-cache-cookie-bypass.ts` need off a request —
 * the plain `header: () => undefined` fake several other specs use is not
 * enough here because the cache path reads `request.cookie(...)` too.
 */
function request(): Request {
  return {
    id: "trace-request",
    method: "GET",
    path: "/trace",
    locale: "en",
    params: {},
    query: {},
    header: () => undefined,
    cookie: () => undefined,
    setValidatedData: vi.fn(),
  } as unknown as Request;
}

/**
 * A `Response` whose `baseResponse` is wired well enough for `.sent` and
 * `.header()` to be readable — the same minimal shape
 * `execute-page-request.spec.ts` hands its own `new Response()` instances.
 */
function response(): Response {
  const instance = new Response();

  (instance as unknown as { baseResponse: { sent: boolean; header: () => void } }).baseResponse = {
    sent: false,
    header: vi.fn(),
  };

  return instance;
}

beforeEach(() => {
  resetTracingConfigForTests();
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
  phases.length = 0;
  resolvePageCacheHitOrMiss.mockReset();
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
  resetTracingConfigForTests();
});

function enableTracing(): void {
  unregister = registerTracingHooks({ onPhase: (_ctx, phase) => phases.push(phase) });
}

describe("page tracing phases", () => {
  it("emits middleware and deferred-settlement phases when tracing is enabled", async () => {
    enableTracing();
    const pageRequest = request();
    const entry: PageRouteEntry = {
      name: "trace",
      path: "/trace",
      triple: {
        app: { middleware: [() => "halt"] },
        layout: {},
        page: { loader: () => ({ value: Promise.resolve("done") }) },
      },
    };

    await executePageRequest({
      url: "/trace",
      routes: [entry],
      createHttp: () => ({ request: pageRequest, response: response() }),
    } as never);

    const deferred = createDeferredSettlement("value", Promise.resolve("done"), 1_000, {
      pathname: "/trace",
      method: "GET",
      request: pageRequest,
    });
    await deferred.settlement;

    expect(phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "page.middleware",
          attrs: expect.objectContaining({ count: 1, outcome: "response" }),
        }),
        expect.objectContaining({
          name: "defer.settle",
          attrs: expect.objectContaining({ key: "value", status: "fulfilled" }),
        }),
      ]),
    );
    for (const phase of phases) {
      expect(typeof phase.startedAt).toBe("number");
    }
  });

  it("emits a cache phase for an opted-in page cache lookup", async () => {
    enableTracing();
    resolvePageCacheHitOrMiss.mockResolvedValue({ served: true });
    const pageRequest = request();
    const handler = createPageRouteHandler({
      path: "/trace",
      name: "trace",
      appFile: "app.tsx",
      pageFile: "page.tsx",
      httpServer: undefined,
      cache: { public: true, maxAge: 60, serverCache: true, tags: ["trace"] },
      loadModule: async (file) => (file === "page.tsx" ? { default: () => null } : {}),
    });

    await handler({ request: pageRequest, response: response() } as never);

    expect(phases).toContainEqual(
      expect.objectContaining({
        name: "page.cache",
        attrs: expect.objectContaining({ status: "hit" }),
      }),
    );
  });

  it("does not emit the new phases when tracing is disabled", async () => {
    const pageRequest = request();
    const entry: PageRouteEntry = {
      name: "trace",
      path: "/trace",
      triple: { app: { middleware: [() => "halt"] }, layout: {}, page: {} },
    };
    await executePageRequest({
      url: "/trace",
      routes: [entry],
      createHttp: () => ({ request: pageRequest, response: response() }),
    } as never);
    resolvePageCacheHitOrMiss.mockResolvedValue({ served: true });
    const handler = createPageRouteHandler({
      path: "/trace",
      name: "trace",
      appFile: "app.tsx",
      pageFile: "page.tsx",
      httpServer: undefined,
      cache: { public: true, maxAge: 60, serverCache: true, tags: ["trace"] },
      loadModule: async (file) => (file === "page.tsx" ? { default: () => null } : {}),
    });
    await handler({ request: pageRequest, response: response() } as never);
    const deferred = createDeferredSettlement("value", Promise.resolve("done"), 1_000, {
      pathname: "/trace",
      method: "GET",
      request: pageRequest,
    });
    await deferred.settlement;

    expect(
      phases.filter((phase) =>
        ["page.middleware", "page.cache", "defer.settle"].includes(phase.name),
      ),
    ).toEqual([]);
  });
});
