import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectPageContext,
  connectPageRoutes,
  PAYLOAD_SCRIPT_ID,
  renderPage,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteMatch,
  type PageRoutesRegistry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import { routes } from "./fixtures/routes";

/**
 * The URL-based production entry over the same P1 fixture as
 * render-page.spec.ts. The url goes straight to stage 1 — no name lookup, no
 * buildUrl — and a url matching nothing is ANSWERED 404, never thrown.
 */

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;
let previousRegistry: PageRoutesRegistry | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as any);
  previousRegistry = connectPageRoutes({
    routes,
    createHttp: (match: PageRouteMatch) =>
      createCoreHttp({ url: match.entry.path, params: match.params, query: match.query }),
  });
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
  connectPageRoutes(previousRegistry);
});

beforeEach(() => {
  // This machine exports NODE_ENV=production globally (A.3 §5 finding).
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("renderPageRequest — url in, document out", () => {
  it("renders a url with params and query into the full document with the payload script", async () => {
    const { html, status, data } = await renderPageRequest("/products/42?user=hasan");

    expect(status).toBe(200);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<h1>Product 42</h1>");
    expect(html).toContain(`<script id="${PAYLOAD_SCRIPT_ID}" type="application/json">`);
    // The url's own segments fed the pipeline: :id from the path, user from
    // the query string — nothing was passed as options.
    expect(data.product.id).toBe("42");
  });

  it("renders the two-line page: a document with no page data", async () => {
    const { html, status, data } = await renderPageRequest("/contact-us");

    expect(status).toBe(200);
    expect(html).toContain("<h1>Contact us</h1>");
    expect(data).toBeUndefined();
  });
});

describe("renderPageRequest — no-match is a 404 answer, not a throw", () => {
  it("answers a url matching NOTHING with status 404 and an empty document", async () => {
    const page = await renderPageRequest("/no-such-page");

    expect(page.status).toBe(404);
    expect(page.html).toBe("");
    expect(page.headers).toEqual({});
    expect(page.cookies).toEqual([]);
    expect(page.data).toBeUndefined();
    // No route matched → no pipeline ran → no bundle (RenderedPage documents
    // this as the ONLY path where bundle is undefined).
    expect(page.bundle).toBeUndefined();
  });
});

describe("renderPageRequest — parity with renderPage (the shared stages-9–10 tail)", () => {
  it("yields the SAME html as renderPage for the same page", async () => {
    const byUrl = await renderPageRequest("/products/42?user=hasan");
    const byName = await renderPage("products.details", {
      params: { id: "42" },
      query: { user: "hasan" },
    });

    expect(byUrl.html).toBe(byName.html);
    expect(byUrl.status).toBe(byName.status);
    expect(byUrl.headers).toEqual(byName.headers);
  });
});
