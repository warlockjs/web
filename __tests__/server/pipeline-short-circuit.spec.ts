import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { v } from "@warlock.js/seal";
import {
  connectPageContext,
  executePageRequest,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageRouteMatch,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import { routes } from "./fixtures/routes";

/**
 * The two pre-loader short-circuits, in stage order: middleware
 * (core's `output !== undefined` rule, request.ts:769) and validation
 * (422 designation, mirroring response.ts:1399-1404). Each must stop the
 * pipeline BEFORE the seal — proven by `bundle.shared` being absent — and
 * before any loader runs — proven by spies.
 */

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as any);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

function runInline(triple: PageRouteEntry["triple"], url = "/inline") {
  return executePageRequest({
    url,
    routes: [{ path: "/inline", name: "inline", triple }],
    createHttp: match => createCoreHttp({ url, params: match.params, query: match.query }),
  });
}

describe("executePageRequest — middleware short-circuit", () => {
  it("fixture guard: layout middleware returning a value stops everything below", async () => {
    const bundle = await executePageRequest({
      url: "/products/42?deny=1",
      routes,
      createHttp: match =>
        createCoreHttp({ url: "/products/42?deny=1", params: match.params, query: match.query }),
    });

    expect(bundle!.shortCircuit).toMatchObject({ stage: "middleware", level: "layout" });
    // Nothing below stage 3 ran: no seal, no loader data, no metadata.
    expect(bundle!.shared).toBeUndefined();
    expect(bundle!.appData).toBeUndefined();
    expect(bundle!.pageData).toBeUndefined();
    expect(bundle!.metadata).toBeUndefined();
    expect(bundle!.commit).toBeUndefined();
  });

  it("skips validation AND loaders (spy proof, page validation would have failed)", async () => {
    const appLoader = vi.fn(async () => ({ fromApp: true }));
    const pageLoader = vi.fn(async () => ({ fromPage: true }));
    const laterMiddleware = vi.fn(async () => undefined);

    const bundle = await runInline({
      app: { loader: appLoader },
      layout: {
        middleware: [async () => ({ denied: true })],
      },
      page: {
        middleware: [laterMiddleware],
        // Would 422 (no `id` in scope) — but validation must never run.
        validation: { schema: v.object({ id: v.string().minLength(2) }) },
        loader: pageLoader,
      },
    });

    // Exact shape, deliberately: the record carries the live response status
    // captured where the pipeline touches the response, so `finishRender` stays
    // a pure function of (triple, bundle). Nothing was set, so it is the default.
    expect(bundle!.shortCircuit).toEqual({
      stage: "middleware",
      level: "layout",
      statusCode: 200,
      value: { denied: true },
    });
    // The chain stopped INSIDE stage 3: the page's own middleware never ran.
    expect(laterMiddleware).not.toHaveBeenCalled();
    // Stage 4 never ran (a validation designation would have replaced the
    // middleware one), stages 5-6 never ran:
    expect(bundle!.shared).toBeUndefined();
    expect(appLoader).not.toHaveBeenCalled();
    expect(pageLoader).not.toHaveBeenCalled();
  });

  /**
   * The discriminator for the case above. A 200-only assertion proves the
   * field is PRESENT; it cannot tell a real capture from a hardcoded 200 —
   * both look identical when the default is all that was ever set.
   *
   * Stages 1-4 are byte-identical to an API request and stage 3 may
   * short-circuit, so a guard denying the request is the canonical non-200
   * short-circuit. Same three hops, driven with 403:
   *   1. middleware sets 403 on the live response, then answers
   *   2. the short-circuit record CARRIES 403 — not 200, not absent
   *   3. the rendered response PRESERVES 403
   */
  it("carries a middleware-set 403 from the live response into the record and out to the rendered status", async () => {
    const url = "/guarded";
    const pageLoader = vi.fn(async () => ({ fromPage: true }));
    const guarded: PageRouteEntry[] = [
      {
        path: url,
        name: "guarded",
        triple: {
          app: {},
          layout: {
            middleware: [
              async ({ response }) => {
                // Exactly what an auth guard does: set the status, then answer.
                response.setStatusCode(403);

                return { error: "forbidden" };
              },
            ],
          },
          page: { loader: pageLoader },
        },
      },
    ];
    const createHttp = (match: PageRouteMatch) =>
      createCoreHttp({ url, params: match.params, query: match.query });

    // Both surfaces run before anything is asserted, and the hops assert
    // softly: a break at the record must not hide whether the render hop
    // survived it. Each hop reports its own verdict.
    const bundle = await executePageRequest({ url, routes: guarded, createHttp });
    const rendered = await renderPageRequest(url, { routes: guarded, createHttp });

    // Hop 1: the guard stopped stage 3, nothing below it ran.
    expect.soft(bundle!.shortCircuit).toMatchObject({ stage: "middleware", level: "layout" });
    expect.soft(pageLoader).not.toHaveBeenCalled();

    // Hop 2: the record took the LIVE status. Exact shape, so 403 must be the
    // VALUE of `statusCode` — a record that fell back to the default fails
    // here on the number, not on the key.
    expect.soft(bundle!.shortCircuit).toEqual({
      stage: "middleware",
      level: "layout",
      statusCode: 403,
      value: { error: "forbidden" },
    });

    // Hop 3: a short-circuit emits no document — the status IS the answer, and
    // it is the guard's 403, never the `?? 200` fallback standing in for an
    // absent field.
    expect.soft(rendered.status).toBe(403);
    expect.soft(rendered.html).toBe("");
  });
});

describe("executePageRequest — validation failure (422 designation)", () => {
  it("fixture page: a 1-char id fails { schema, validating } and stops before the seal", async () => {
    const bundle = await executePageRequest({
      url: "/products/x",
      routes,
      createHttp: match => createCoreHttp({ url: "/products/x", params: match.params, query: match.query }),
    });

    expect(bundle!.shortCircuit).toMatchObject({ stage: "validation", status: 422 });
    expect((bundle!.shortCircuit as any).errors).toBeInstanceOf(Array);
    expect((bundle!.shortCircuit as any).errors.length).toBeGreaterThan(0);
    // Stopped before stage 5 (seal) and stage 6 (loaders):
    expect(bundle!.shared).toBeUndefined();
    expect(bundle!.appData).toBeUndefined();
    expect(bundle!.layoutData).toBeUndefined();
    expect(bundle!.pageData).toBeUndefined();
    expect(bundle!.metadata).toBeUndefined();
  });

  it("no loader runs after a validation failure (spy proof)", async () => {
    const appLoader = vi.fn(async () => ({ fromApp: true }));
    const layoutLoader = vi.fn(async () => ({ fromLayout: true }));
    const pageLoader = vi.fn(async () => ({ fromPage: true }));

    const bundle = await runInline({
      app: { loader: appLoader },
      layout: { loader: layoutLoader },
      page: {
        validation: { schema: v.object({ token: v.string().minLength(8) }) },
        loader: pageLoader,
      },
    });

    expect(bundle!.shortCircuit).toMatchObject({ stage: "validation", status: 422 });
    expect(appLoader).not.toHaveBeenCalled();
    expect(layoutLoader).not.toHaveBeenCalled();
    expect(pageLoader).not.toHaveBeenCalled();
  });

});

describe("executePageRequest — validation over params (real request.validated)", () => {
  it("stage 4 success path calls core's setValidatedData (request.ts:721-723)", async () => {
    let observed: unknown;
    const url = "/things/42";

    const bundle = await executePageRequest({
      url,
      routes: [
        {
          path: "/things/:id",
          name: "things.show",
          triple: {
            app: {},
            layout: {},
            page: {
              validation: { schema: v.object({ id: v.string().minLength(2) }) },
              loader: async ({ request }: any) => {
                observed = request.validated();
                return { ok: true };
              },
            },
          },
        },
      ],
      createHttp: match => createCoreHttp({ url, params: match.params, query: match.query }),
    });

    expect(bundle!.shortCircuit).toBeUndefined();
    expect(bundle!.pageData).toEqual({ ok: true });
    expect(observed).toEqual({ id: "42" });
  });
});
