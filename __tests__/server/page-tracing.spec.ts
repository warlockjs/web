/**
 * PAGE TRACING — web half: web reports its phases through core's `onPhase`
 * hook; it never gets its own hook surface.
 *
 * Phases under test:
 *   - "loader"       — one per level that actually ran (`execute-page-request.ts`)
 *   - "render.shell" — render start until React's shell is ready (`render-page.ts`)
 *   - "stream.end"   — until the response has finished sending, including
 *                      every deferred settlement (`create-page-route-handler.ts`)
 *
 * Real core `Request`/`Response` throughout (`createCoreHttp`,
 * `fixtures/core-http.ts`) and the real `createPageRouteHandler`, the same
 * construction `streamed-document.parity.spec.ts` and `defer-streaming.spec.ts`
 * in this directory use — a hand mock of `response.streamReact` would prove
 * nothing about the real wire seam "stream.end" times.
 */
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import config from "@mongez/config";
import {
  resetTracingConfigForTests,
  type HttpContext,
  type TracingContext,
  type TracingHooks,
  type TracingPhaseInfo,
} from "@warlock.js/core";
import { defer } from "../../src/loaders/defer";
import {
  createPageRouteHandler,
  type PageModuleLoader,
} from "../../src/server/create-page-route-handler";
import { connectPageContext, type PageContextRunner } from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import * as App from "./fixtures/root";
import * as layout from "./fixtures/layout";

const APP_FILE = "/fixtures/web/root.tsx";
const LAYOUT_FILE = "/fixtures/web/layout.tsx";
const PAGE_FILE = "/fixtures/web/tracing.page.tsx";
const DEFER_PAGE_FILE = "/fixtures/web/tracing-defer.page.tsx";

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
  resetTracingConfigForTests();
});

afterEach(() => {
  config.set("http.tracing", undefined);
  resetTracingConfigForTests();
});

function moduleLoader(modules: Record<string, unknown>): PageModuleLoader {
  return async (moduleId: string) => {
    const module = modules[moduleId];

    if (!module) throw new Error(`fake loader: nothing registered for "${moduleId}"`);

    return module;
  };
}

/** Flush every pending microtask AND macrotask. */
async function flushAsyncWork(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type RecordedPhase = { ctx: TracingContext; phase: TracingPhaseInfo };

function trackingHook(): { hook: TracingHooks; phases: RecordedPhase[] } {
  const phases: RecordedPhase[] = [];

  return {
    phases,
    hook: {
      onPhase: (ctx, phase) => phases.push({ ctx, phase }),
    },
  };
}

describe("page tracing — enabled: loader (per level), render.shell, stream.end", () => {
  it(
    "emits loader(app), loader(layout), loader(page), render.shell, stream.end in order, all with numeric durations",
    async () => {
      const page = {
        loader: async () => ({ greeting: "hi" }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const handler = createPageRouteHandler({
        path: "/tracing",
        name: "tracing",
        appFile: APP_FILE,
        pageFile: PAGE_FILE,
        layoutFile: LAYOUT_FILE,
        loadModule: moduleLoader({ [APP_FILE]: App, [LAYOUT_FILE]: layout, [PAGE_FILE]: page }),
        applyBufferedCookie: () => undefined,
        httpServer: undefined,
      });

      const http = createCoreHttp({ url: "/tracing" });
      http.reply.raw.on("data", () => undefined);

      const { hook, phases } = trackingHook();
      config.set("http.tracing", { enabled: true, hooks: [hook] });

      const startedAt = Date.now();
      await handler({ request: http.request, response: http.response } as unknown as HttpContext);
      const wallClockMs = Date.now() - startedAt;

      expect(phases.map(({ phase }) => phase.name)).toEqual([
        "loader",
        "loader",
        "loader",
        "render.shell",
        "stream.end",
      ]);

      expect(phases[0]!.phase.attrs).toEqual({ level: "app" });
      expect(phases[1]!.phase.attrs).toEqual({ level: "layout", layoutPath: LAYOUT_FILE });
      expect(phases[2]!.phase.attrs).toEqual({ level: "page" });

      // Every phase has a real, non-negative numeric duration, and every one
      // fits within the wall-clock window this one request actually took —
      // i.e. it happened "inside" this request's start/end, not before or
      // after it. A few ms of slack covers timer-resolution rounding.
      for (const { ctx, phase } of phases) {
        expect(typeof phase.durationMs).toBe("number");
        expect(Number.isFinite(phase.durationMs)).toBe(true);
        expect(phase.durationMs).toBeGreaterThanOrEqual(0);
        expect(phase.durationMs).toBeLessThanOrEqual(wallClockMs + 50);

        // Every phase correlates to the SAME request.
        expect(ctx.requestId).toBe(http.request.id);
        expect(ctx.traceId).toBe(http.request.traceId);
      }
    },
    20_000,
  );
});

describe("page tracing — deferred page: stream.end comes after the last settlement", () => {
  it(
    "does not dispatch stream.end until the deferred value has settled",
    async () => {
      let releaseReviews!: (value: unknown) => void;
      const reviews = new Promise((resolve) => {
        releaseReviews = resolve;
      });

      const page = {
        loader: async () => defer({ greeting: "hi", reviews }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const handler = createPageRouteHandler({
        path: "/tracing-defer",
        name: "tracing-defer",
        appFile: APP_FILE,
        pageFile: DEFER_PAGE_FILE,
        layoutFile: undefined,
        loadModule: moduleLoader({ [APP_FILE]: App, [DEFER_PAGE_FILE]: page }),
        applyBufferedCookie: () => undefined,
        httpServer: undefined,
      });

      const http = createCoreHttp({ url: "/tracing-defer" });
      http.reply.raw.on("data", () => undefined);

      const { hook, phases } = trackingHook();
      config.set("http.tracing", { enabled: true, hooks: [hook] });

      const pending = handler({
        request: http.request,
        response: http.response,
      } as unknown as HttpContext);

      // The shell has every chance to flush before the deferred value settles
      // — "stream.end" must not have fired yet.
      await flushAsyncWork();
      expect(phases.some(({ phase }) => phase.name === "stream.end")).toBe(false);
      expect(http.reply.raw.writableEnded).toBe(false);

      releaseReviews([{ id: 1, rating: 5 }]);
      await pending;

      const streamEndPhases = phases.filter(({ phase }) => phase.name === "stream.end");

      expect(streamEndPhases).toHaveLength(1);
      expect(http.reply.raw.writableEnded).toBe(true);
    },
    20_000,
  );
});

describe("page tracing — disabled: no hook is called", () => {
  it("never calls onPhase for a full app+layout+page render", async () => {
    config.set("http.tracing", { enabled: false });

    const page = {
      loader: async () => ({ greeting: "hi" }),
      default: ({ data }: { data: { greeting: string } }) =>
        createElement("main", null, data.greeting),
    };

    const handler = createPageRouteHandler({
      path: "/tracing-disabled",
      name: "tracing-disabled",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      layoutFile: LAYOUT_FILE,
      loadModule: moduleLoader({ [APP_FILE]: App, [LAYOUT_FILE]: layout, [PAGE_FILE]: page }),
      applyBufferedCookie: () => undefined,
      httpServer: undefined,
    });

    const http = createCoreHttp({ url: "/tracing-disabled" });
    http.reply.raw.on("data", () => undefined);

    const { hook, phases } = trackingHook();
    config.set("http.tracing", { enabled: false, hooks: [hook] });

    await handler({ request: http.request, response: http.response } as unknown as HttpContext);

    expect(phases).toHaveLength(0);
  });
});
