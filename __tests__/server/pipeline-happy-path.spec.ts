import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectPageContext,
  executePageRequest,
  type PageContextRunner,
  type PageRouteMatch,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import { routes } from "./fixtures/routes";

/**
 * Stages 1–8 end to end over the hand-authored fixture, against REAL core
 * Request/Response instances (fixtures/core-http.ts mirrors router.ts:924-932)
 * and core's REAL requestContext — `connectPageContext(requestContext)` below
 * is the exact boot wiring the production bootstrap will perform, executing
 * core's own `Context.run` (context/src/base-context.ts:83-85) per request.
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

beforeEach(() => {
  // This suite exercises the DEV pipeline, stated here rather than inherited
  // from the launching shell: `sealShared()` gates its deep freeze on Vite's
  // built-in DEV flag, so pin that flag — not NODE_ENV, which the gate never
  // reads — and the freeze assertions below hold on any box.
  vi.stubEnv("DEV", true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function runFixture(url: string) {
  const created: ReturnType<typeof createCoreHttp>[] = [];

  const result = executePageRequest({
    url,
    routes,
    createHttp(match: PageRouteMatch) {
      const http = createCoreHttp({ url, params: match.params, query: match.query });
      created.push(http);
      return http;
    },
  });

  return { result, created };
}

describe("executePageRequest — happy path (stages 1-8)", () => {
  it("returns the full data bundle for the full-surface page", async () => {
    const { result, created } = runFixture("/products/42?user=hasan");
    const bundle = await result;

    expect(bundle).toBeDefined();

    // stage 1 — match against the mini manifest
    expect(bundle!.route).toEqual({
      name: "products.details",
      path: "/products/:id",
      params: { id: "42" },
      query: { user: "hasan" },
    });

    // stages 3+5 — middleware wrote shared, seal returned the sealed target
    const shared = bundle!.shared as any;

    expect(shared).toBeDefined();
    expect(shared.locale).toBe("en");
    expect(shared.appName).toBe("Fixture Store");
    expect(shared.user).toEqual({ name: "hasan" });
    // The bundle carries sealShared()'s RETURN — the target itself, deep-frozen
    // because DEV is pinned true above. (The freeze is belt-and-braces and is
    // compiled out of production builds; the sealed-write throw is what enforces
    // the contract, and it is not env-gated.)
    expect(Object.isFrozen(bundle!.shared)).toBe(true);

    // stage 6 — every loader's data, and every loader saw the SAME sealed
    // shared: each fixture loader echoes what it read back into its data.
    expect(bundle!.appData).toEqual({ appName: "Fixture Store" });
    expect(bundle!.layoutData).toEqual({ nav: ["home", "products"], locale: "en" });
    expect(bundle!.pageData).toEqual({
      product: { id: "42", name: "Product 42", locale: "en" },
    });
    expect((bundle!.appData as any).appName).toBe(shared.appName);
    expect((bundle!.layoutData as any).locale).toBe(shared.locale);
    expect((bundle!.pageData as any).product.locale).toBe(shared.locale);

    // stage 7 — the page loader's buffered writes were committed to the REAL
    // core Response, which wrote through to the fastify reply shim.
    const { reply } = created[0];

    expect(reply.appliedHeaders["x-fixture-level"]).toBe("page");
    expect(reply.appliedHeaders["cache-control"]).toBe("private, max-age=60");
    // Cookies are NOT mirrored onto the live response at stage 7 — only the
    // emit writes them, exactly once. header()/setStatusCode() are keyed SETs
    // and so are idempotent with the emit; cookie() APPENDS, which is why
    // mirroring it produced a duplicate Set-Cookie on every page response.
    // The committed cookie is asserted on the settle result below; its
    // wire-level counterpart lives in page-redirect-wire.spec.ts.
    // The BUFFER holds the raw value; core's Response.cookie JSON-stringifies
    // at the wire (response.ts:958), so the encoded form is asserted there.
    expect(reply.cookies).toEqual([]);
    expect(bundle!.commit!.cookies).toEqual([
      expect.objectContaining({ name: "last-product", value: "42" }),
    ]);
    expect(bundle!.commit).toMatchObject({
      committedLevels: ["app", "layout", "page"],
    });
    expect(bundle!.commit!.headers.map(header => header.key.toLowerCase())).toEqual([
      "x-fixture-level",
      "cache-control",
    ]);

    // stage 8 — metadata computed from the page loader's data
    expect(bundle!.metadata).toEqual({ title: "Product 42" });

    // no abnormal outcome
    expect(bundle!.shortCircuit).toBeUndefined();
    expect(bundle!.error).toBeUndefined();
  });

  it("runs the two-line page: no loader, no metadata, still a sealed shared payload", async () => {
    const { result } = runFixture("/contact-us");
    const bundle = await result;

    expect(bundle).toBeDefined();
    expect(bundle!.route.name).toBe("main.contact-us");
    expect(bundle!.pageData).toBeUndefined();
    expect(bundle!.metadata).toBeUndefined();

    // The document is still personalized: App middleware ran, shared sealed.
    expect((bundle!.shared as any).appName).toBe("Fixture Store");
    // Frozen under the DEV flag pinned above, same as the full-surface page.
    expect(Object.isFrozen(bundle!.shared)).toBe(true);
    expect(bundle!.commit!.headers).toEqual([]);
    expect(bundle!.shortCircuit).toBeUndefined();
  });

  it("returns undefined for a URL no manifest entry matches", async () => {
    const { result, created } = runFixture("/no-such-page");

    await expect(result).resolves.toBeUndefined();
    // stage 1 misses before any Request/Response is ever constructed
    expect(created).toHaveLength(0);
  });

  // SCOPE (R1 negative control, 2026-08-20): a green here buys "no gross bleed
  // between two requests" — nothing more. It does NOT buy spike P3: there is no
  // ≥50-concurrent barrier here (this is 2 requests, not ≥50; one store, not
  // four; one run, not 10 seeded). Verified red-able: caching a single shared
  // scope across requests fails this test loudly (the second request trips the
  // seal guard on the first request's sealed scope — see
  // implementation/2026-08-20-R1-negative-control.md). This spec is P3's
  // HARNESS SEED: grow it to the eeade955 criteria; do not rewrite it under
  // gate pressure.
  it("isolates two concurrent page requests: each bundle sees its own shared", async () => {
    const [first, second] = await Promise.all([
      runFixture("/products/42?user=amber").result,
      runFixture("/products/77?user=noor").result,
    ]);

    expect((first!.shared as any).user).toEqual({ name: "amber" });
    expect((second!.shared as any).user).toEqual({ name: "noor" });
    expect((first!.pageData as any).product.id).toBe("42");
    expect((second!.pageData as any).product.id).toBe("77");
  });
});
