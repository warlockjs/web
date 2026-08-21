import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectPageContext,
  connectPageRoutes,
  PAYLOAD_SCRIPT_ID,
  renderPage,
  type PageContextRunner,
  type PageRouteEntry,
  type PageRouteMatch,
  type PageRoutesRegistry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import * as App from "./fixtures/App";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import * as layout from "./fixtures/layout";
import { routes } from "./fixtures/routes";

/**
 * Stages 9–10 over the P1 fixture: renderPage runs the WHOLE pipeline
 * (executePageRequest, untouched) and returns { html, status, headers, data }
 * in one call — dx-differentiators.md §3's "page tests are controller tests"
 * is this file's shape, not just its subject.
 */

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;
let previousRegistry: PageRoutesRegistry | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as any);
  // The boot wiring renderPage adds on top of P1's two connects: the route
  // registry, so a route NAME is enough at the call site.
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

/** The emitted payload script's exact content — the bytes the browser gets. */
function extractPayload(html: string): string {
  const open = `<script id="${PAYLOAD_SCRIPT_ID}" type="application/json">`;
  const start = html.indexOf(open);

  expect(start).toBeGreaterThan(-1);

  const end = html.indexOf("</script>", start);

  return html.slice(start + open.length, end);
}

describe("renderPage — stage 9 RENDER", () => {
  it("renders the fixture contact page: its own DOM inside the App/Layout chrome", async () => {
    const { html, status } = await renderPage("main.contact-us");

    expect(status).toBe(200);
    expect(html).toContain("<h1>Contact us</h1>");
    expect(html).toContain("support@fixture.store");
    // Root→leaf composition: <App><Layout><Page/></Layout></App>.
    expect(html).toContain('<div id="app"');
    expect(html).toContain('<div id="layout"');
    expect(html.indexOf('id="app"')).toBeLessThan(html.indexOf('id="layout"'));
    expect(html.indexOf('id="layout"')).toBeLessThan(html.indexOf("<h1>Contact us</h1>"));
  });

  it("gives each component ITS OWN loader data and the sealed shared", async () => {
    const { html } = await renderPage("products.details", {
      params: { id: "42" },
      query: { user: "hasan" },
    });

    // Page rendered pageData; Layout rendered layoutData; App rendered appData.
    expect(html).toContain("<h1>Product 42</h1>");
    expect(html).toContain("home | products");
    expect(html).toContain('data-app-name="Fixture Store"');
    // The page component read `shared.locale` — same sealed object as the data.
    expect(html).toContain("<p>en</p>");
  });
});

describe("renderPage — stage 10 EMIT", () => {
  it("emits <head> from the metadata export's output", async () => {
    const { html } = await renderPage("products.details", { params: { id: "42" } });

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // metadata ran server-side after the loader, on the loader's data.
    expect(html).toContain("<head>");
    expect(html).toContain("<title>Product 42</title>");
  });

  it("serializes appData + layoutData + pageData + shared — and NEVER request/response (asserted on the emitted bytes)", async () => {
    const { html, bundle } = await renderPage("products.details", {
      params: { id: "42" },
      query: { user: "hasan" },
    });

    const payload = extractPayload(html);

    // Spike P7 precedent: the assertion is on the emitted string itself.
    expect(payload).not.toContain('"request"');
    expect(payload).not.toContain('"response"');
    expect(html).not.toContain('"request"');
    expect(html).not.toContain('"response"');

    const parsed = JSON.parse(payload);

    expect(parsed.appData).toEqual({ appName: "Fixture Store" });
    expect(parsed.layoutData).toEqual({ nav: ["home", "products"], locale: "en" });
    expect(parsed.pageData).toEqual({
      product: { id: "42", name: "Product 42", locale: "en" },
    });
    // `shared` in the payload is sealShared's RETURN as the bundle carries it —
    // the same values, serialized from the sealed target, never a proxy re-read.
    expect(parsed.shared).toEqual(bundle.shared);
    expect(parsed.shared.user).toEqual({ name: "hasan" });
  });

  it("escapes the payload against </script, <!--, -->, U+2028, U+2029 (canon 20c425dd §3 stage 10)", async () => {
    const attack = '</script><script>alert(1)</script><!-- sneak -->\u2028\u2029';
    const escapingRoutes: PageRouteEntry[] = [
      {
        path: "/escape",
        name: "test.escape",
        triple: {
          app: App,
          layout,
          page: {
            route: "/escape",
            loader: async () => ({ attack }),
            default: () => null,
          },
        },
      },
    ];

    const { html } = await renderPage("test.escape", { routes: escapingRoutes });
    const payload = extractPayload(html);

    // None of the forbidden byte sequences survive in the inline script…
    expect(payload).not.toContain("</script");
    expect(payload).not.toContain("<!--");
    expect(payload).not.toContain("-->");
    expect(payload).not.toContain("\u2028");
    expect(payload).not.toContain("\u2029");
    // …because every one of them was emitted in \uXXXX form…
    expect(payload).toContain("\\u003c/script\\u003e");
    expect(payload).toContain("\\u003c!--");
    expect(payload).toContain("--\\u003e");
    expect(payload).toContain("\\u2028");
    expect(payload).toContain("\\u2029");
    // …which is the SAME string after JSON parsing — escaping, not mangling.
    expect(JSON.parse(payload).pageData.attack).toBe(attack);
  });

  it("defaults the document to Cache-Control: private (README rule 8) when no loader answered for the key", async () => {
    const { headers } = await renderPage("main.contact-us");

    // contact-us has no loader and therefore nowhere to write a header — the
    // exact case that makes this a framework default instead of a convention.
    expect(headers["cache-control"]).toBe("private");
  });

  it("lets a loader's committed cache-control stand", async () => {
    const { headers } = await renderPage("products.details", { params: { id: "42" } });

    expect(headers["cache-control"]).toBe("private, max-age=60");
  });
});

describe("renderPage — boundary path", () => {
  const boom = new Error("inventory backend down");

  function throwingRoutes(): PageRouteEntry[] {
    return [
      {
        path: "/exploding",
        name: "test.exploding",
        triple: {
          app: App,
          layout,
          page: {
            route: "/exploding",
            loader: async () => {
              throw boom;
            },
            default: () => createElement("h1", null, "never rendered"),
            ErrorBoundary: ({ error }: { error: Error }) =>
              createElement("main", { role: "alert" }, `Boundary: ${error.message}`),
          },
        },
      },
    ];
  }

  it("renders the DESIGNATED boundary component and the framework owns the status", async () => {
    const { html, status } = await renderPage("test.exploding", { routes: throwingRoutes() });

    // The boundary rendered — with the real error — in place of the page…
    expect(html).toContain('<main role="alert">Boundary: inventory backend down</main>');
    expect(html).not.toContain("never rendered");
    // …still wrapped by the rootward chrome, whose data survived the settle
    // rules (P1 §4: fulfilled sibling data stays field-by-field)…
    expect(html).toContain('data-app-name="Fixture Store"');
    expect(html).toContain("home | products");
    // …and the framework owns the status: P1's commit forced 500.
    expect(status).toBe(500);
  });

  it("keeps the thrower's data OUT of the payload and the boundary document private", async () => {
    const { html, headers } = await renderPage("test.exploding", { routes: throwingRoutes() });
    const payload = extractPayload(html);
    const parsed = JSON.parse(payload);

    // JSON.stringify drops undefined keys: the throwing level has no data.
    expect(payload).not.toContain('"pageData"');
    expect(parsed.appData).toEqual({ appName: "Fixture Store" });
    expect(parsed.layoutData).toEqual({ nav: ["home", "products"], locale: "en" });
    // The error itself never reaches the emitted bytes.
    expect(html).not.toContain('"inventory backend down"');
    expect(headers["cache-control"]).toBe("private");
  });
});

describe("renderPage — the one-call test-helper contract (dx-differentiators.md §3 DoD)", () => {
  it("asserts a page's data AND its response headers in one call", async () => {
    const { data, headers } = await renderPage("products.details", {
      params: { id: "42" },
      query: { user: "hasan" },
    });

    expect(data.product.name).toBe("Product 42");
    expect(headers["cache-control"]).toBe("private, max-age=60");
  });

  it("returns the committed cookies with their raw values", async () => {
    const { cookies } = await renderPage("products.details", { params: { id: "42" } });

    expect(cookies).toEqual([expect.objectContaining({ name: "last-product", value: "42" })]);
  });

  it("carries every cookie attribute through untransformed — httpOnly/secure/sameSite are expressible", async () => {
    const cookieRoutes: PageRouteEntry[] = [
      {
        path: "/session-cookie",
        name: "test.session-cookie",
        triple: {
          app: App,
          layout,
          page: {
            route: "/session-cookie",
            loader: async ({ response }: any) => {
              response.cookie("first", "plain");
              response.cookie("session", "token-1", {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                path: "/",
              });
              return {};
            },
            default: () => null,
          },
        },
      },
    ];

    const { cookies } = await renderPage("test.session-cookie", { routes: cookieRoutes });

    // Exact equality, not a projection: the attributes AND the commit order
    // must survive byte-for-byte — a surface that drops httpOnly/secure/
    // sameSite ships an insecure Set-Cookie as the default.
    expect(cookies).toEqual([
      { name: "first", value: "plain", options: undefined },
      {
        name: "session",
        value: "token-1",
        options: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      },
    ]);
  });

  it("asserting a guard rejection is one line", async () => {
    await expect(renderPage("main.contact-us", { query: { deny: "1" } })).resolves.toMatchObject({ status: 401, html: "" });
  });

  it("asserting a loader's notFound answer is one line", async () => {
    await expect(renderPage("products.details", { params: { id: "missing" } })).resolves.toMatchObject({ status: 404, html: "" });
  });

  it("asserting a validation rejection is one line", async () => {
    await expect(renderPage("products.details", { params: { id: "x" } })).resolves.toMatchObject({ status: 422 });
  });

  it("impersonates with `as`: the value lands on request.user before the pipeline runs", async () => {
    const asRoutes: PageRouteEntry[] = [
      {
        path: "/whoami",
        name: "test.whoami",
        triple: {
          app: App,
          layout,
          page: {
            route: "/whoami",
            loader: async ({ request }: any) => ({ userName: request.user?.name }),
            default: () => null,
          },
        },
      },
    ];

    const { data } = await renderPage("test.whoami", {
      routes: asRoutes,
      as: { id: 1, name: "Hasan" },
    });

    expect(data.userName).toBe("Hasan");
  });
});
