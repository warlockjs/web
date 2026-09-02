/**
 * Real response `Cache-Control` headers for a page route whose handling
 * touched auth state, proven against an actual Fastify response rather than
 * against the function that sets it — see `static-asset-cache-headers.spec.ts`
 * for the same pattern applied to a different header.
 *
 * `renderPageRequest` is mocked (as `create-page-route-handler.spec.ts` does)
 * so the test controls exactly when `request.user` / `request.decodedAccessToken`
 * are assigned, without needing a real page/layout/app module graph. Assigning
 * either is what core's `Request` marks `authDerived` for
 * (`core/src/http/request.ts`) — this suite proves the mark is read where the
 * response headers are actually written, not merely that the mark gets set.
 *
 * No standalone dev/production server is started here: `router.scan(server)`
 * plus `server.inject()` exercises the real route on an in-memory Fastify
 * instance that never binds a port.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { router, type Request } from "@warlock.js/core";
import { WARLOCK_DATA_REQUEST_HEADER, WARLOCK_DATA_REQUEST_VALUE } from "../routing/data-request";

const { renderPageRequest } = vi.hoisted(() => ({
  renderPageRequest: vi.fn(),
}));

vi.mock("./render-page", () => ({ renderPageRequest }));

import { createPageRouteHandler } from "./create-page-route-handler";

function renderedOk() {
  return {
    html: "<!doctype html><html><body>ok</body></html>",
    status: 200,
    headers: {},
    data: undefined,
    bundle: undefined,
  };
}

const moduleById: Record<string, unknown> = {
  "app.tsx": {},
  "layout.tsx": {},
  "page.tsx": {},
};

function registerRoute(urlPath: string): void {
  router.get(
    urlPath,
    createPageRouteHandler({
      path: urlPath,
      name: urlPath,
      appFile: "app.tsx",
      layoutFile: "layout.tsx",
      pageFile: "page.tsx",
      loadModule: async (moduleId) => moduleById[moduleId],
    }),
  );
}

/** Whatever the currently running test wants done to `request` mid-render. */
let touchAuth: (request: Request) => void = () => {};

describe("auth-derived Cache-Control headers", () => {
  const server = Fastify();

  beforeAll(() => {
    registerRoute("/__auth-cache-innocent");
    registerRoute("/__auth-cache-user");
    registerRoute("/__auth-cache-token-only");

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

  it("leaves a page that never touches auth state without no-store, on the document", async () => {
    const response = await server.inject({ method: "GET", url: "/__auth-cache-innocent" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).not.toBe("private, no-store");
  });

  it("leaves a page that never touches auth state without no-store, on the data representation", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/__auth-cache-innocent",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).not.toBe("private, no-store");
  });

  it("marks the document private, no-store when the request touched request.user", async () => {
    touchAuth = (request) => {
      request.user = { id: 1 } as never;
    };

    const response = await server.inject({ method: "GET", url: "/__auth-cache-user" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("marks the data representation private, no-store when the request touched request.user", async () => {
    touchAuth = (request) => {
      request.user = { id: 1 } as never;
    };

    const response = await server.inject({
      method: "GET",
      url: "/__auth-cache-user",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("marks the document private, no-store when the request touched only decodedAccessToken", async () => {
    touchAuth = (request) => {
      request.decodedAccessToken = { userType: "member" };
    };

    const response = await server.inject({ method: "GET", url: "/__auth-cache-token-only" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});
