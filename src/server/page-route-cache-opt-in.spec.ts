/**
 * Real response `Cache-Control` headers for a page route that opted in via
 * `route.cache: { public: true, maxAge }`, proven against an actual Fastify
 * response rather than against the function that sets it — same pattern as
 * `set-cookie-cache-floor.spec.ts` and `auth-derived-cache-headers.spec.ts`,
 * applied to the opt-in half of `response-cache-floor.ts`'s precedence.
 *
 * `renderPageRequest` is mocked so the test controls exactly what each route
 * "commits" — cookies — without needing a real page/layout/app module graph.
 * The `cache` option is handed to `createPageRouteHandler` directly, exactly
 * the way `install-page-routes.ts` / `install-page-routes-from-manifest.ts`
 * would after resolving it off the page's real `route` export
 * (`resolvePageRouteCache`, `../routing/route-identity.ts`) — this suite is
 * about what the seam DOES with an already-resolved opt-in, not about how it
 * gets resolved (that is `route-identity.spec.ts`'s job).
 *
 * No standalone dev/production server is started here: `router.scan(server)`
 * plus `server.inject()` exercises the real route on an in-memory Fastify
 * instance that never binds a port.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHttpPlugins, router, type Request } from "@warlock.js/core";
import { WARLOCK_DATA_REQUEST_HEADER, WARLOCK_DATA_REQUEST_VALUE } from "../routing/data-request";
import type { PageCacheOptIn } from "../routing/route-identity";
import type { BufferedCookie } from "./execute-page-request";

const { renderPageRequest } = vi.hoisted(() => ({
  renderPageRequest: vi.fn(),
}));

vi.mock("./render-page", () => ({ renderPageRequest }));

import { createPageRouteHandler } from "./create-page-route-handler";

function renderedOk(
  overrides: { headers?: Record<string, string>; cookies?: BufferedCookie[] } = {},
) {
  return {
    html: "<!doctype html><html><body>ok</body></html>",
    status: 200,
    headers: overrides.headers ?? {},
    cookies: overrides.cookies ?? [],
    data: undefined,
    bundle: undefined,
  };
}

const moduleById: Record<string, unknown> = {
  "app.tsx": {},
  "layout.tsx": {},
  "page.tsx": {},
};

function registerRoute(urlPath: string, httpServer: FastifyInstance, cache?: PageCacheOptIn): void {
  router.get(
    urlPath,
    createPageRouteHandler({
      path: urlPath,
      name: urlPath,
      appFile: "app.tsx",
      layoutFile: "layout.tsx",
      pageFile: "page.tsx",
      loadModule: async (moduleId) => moduleById[moduleId],
      httpServer,
      cache,
    }),
  );
}

/** Whatever the currently running test wants done to `request` mid-render. */
let touchAuth: (request: Request) => void = () => {};

describe("page route cache opt-in", () => {
  const server = Fastify();

  beforeAll(async () => {
    await registerHttpPlugins(server);

    registerRoute("/__cache-innocent", server);
    registerRoute("/__cache-opted-in", server, { public: true, maxAge: 120 });
    registerRoute("/__cache-opted-in-cookie", server, { public: true, maxAge: 120 });
    registerRoute("/__cache-opted-in-auth", server, { public: true, maxAge: 120 });

    router.scan(server);
  });

  beforeEach(() => {
    renderPageRequest.mockReset();
    touchAuth = () => {};
    renderPageRequest.mockImplementation(
      async (_url: string, options: { createHttp: () => { request: Request } }) => {
        const { request } = options.createHttp();
        touchAuth(request);
        return renderedOk();
      },
    );
  });

  afterAll(async () => {
    await server.close();
  });

  // ── 1. INNOCENT CASE FIRST ────────────────────────────────────────────────
  it("innocent case: a route with no cache field is no-store on the document", async () => {
    const response = await server.inject({ method: "GET", url: "/__cache-innocent" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("innocent case: a route with no cache field is no-store on the data representation", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/__cache-innocent",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  // ── 2 & 3. Opted-in route ─────────────────────────────────────────────────
  it("emits public, max-age=<maxAge> on the document for an opted-in route", async () => {
    const response = await server.inject({ method: "GET", url: "/__cache-opted-in" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=120");
  });

  it("emits public, max-age=<maxAge> on the data representation, so it cannot diverge from the document", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/__cache-opted-in",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=120");
  });

  // ── 4. THE MOST IMPORTANT TEST IN THIS SLICE ─────────────────────────────
  it("an opted-in route whose response sets a cookie still emits private, no-store — the cookie floor beats the opt-in", async () => {
    renderPageRequest.mockResolvedValue(
      renderedOk({ cookies: [{ name: "session", value: "abc", options: { raw: true } }] }),
    );

    const response = await server.inject({ method: "GET", url: "/__cache-opted-in-cookie" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  // ── 5. Auth-derived floor beats the opt-in ───────────────────────────────
  it("an opted-in route on an auth-derived request still emits private, no-store — the auth floor beats the opt-in", async () => {
    touchAuth = (request) => {
      request.user = { id: 1 } as never;
    };

    const response = await server.inject({ method: "GET", url: "/__cache-opted-in-auth" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});
