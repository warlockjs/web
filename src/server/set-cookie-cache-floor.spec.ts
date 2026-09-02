/**
 * Real response `Cache-Control` headers for a page route whose response
 * carries a `Set-Cookie` header, proven against an actual Fastify response
 * rather than against the function that sets it — same pattern as
 * `auth-derived-cache-headers.spec.ts`, applied to the cookie half of the
 * floor (`response-cache-floor.ts` / `set-cookie-cache-floor-hook.ts`).
 *
 * `renderPageRequest` is mocked so the test controls exactly what each route
 * "commits" — cookies, headers — without needing a real page/layout/app
 * module graph.
 *
 * No standalone dev/production server is started here: `router.scan(server)`
 * plus `server.inject()` exercises the real route on an in-memory Fastify
 * instance that never binds a port.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHttpPlugins, router } from "@warlock.js/core";
import { WARLOCK_DATA_REQUEST_HEADER, WARLOCK_DATA_REQUEST_VALUE } from "../routing/data-request";
import { ensureSetCookieCacheFloorHook } from "./set-cookie-cache-floor-hook";
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

function registerRoute(urlPath: string, httpServer: FastifyInstance): void {
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
    }),
  );
}

describe("Set-Cookie Cache-Control floor", () => {
  const server = Fastify();

  beforeAll(async () => {
    await registerHttpPlugins(server);

    // A plain, non-page route — registered directly on the Fastify instance,
    // never through `createPageRouteHandler`, so `request.locals.isPageResponse`
    // is never set. It sets its OWN Cache-Control and its own cookie, the same
    // way an ordinary API controller might. Exists to prove the hook's SCOPE:
    // instance-wide registration must not widen the floor's EFFECT to every
    // response that merely carries a Set-Cookie.
    server.get("/__ordinary-api-with-cookie", async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=60");
      reply.setCookie("session", "abc", {});
      return { ok: true };
    });

    registerRoute("/__set-cookie-innocent", server);
    registerRoute("/__set-cookie-committed", server);
    registerRoute("/__set-cookie-literal-header", server);
    registerRoute("/__set-cookie-clear", server);

    router.scan(server);
  });

  beforeEach(() => {
    renderPageRequest.mockReset();
  });

  afterAll(async () => {
    await server.close();
  });

  it("SCOPE, proven first: leaves an ordinary (non-page) API response's Cache-Control byte-identical even though it carries a Set-Cookie — the hook's effect is scoped to responses the page pipeline marked, not inferred from Set-Cookie presence alone", async () => {
    const response = await server.inject({ method: "GET", url: "/__ordinary-api-with-cookie" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("leaves a page that sets no cookie and touches no auth without no-store (innocent case must pass first)", async () => {
    renderPageRequest.mockResolvedValue(renderedOk());

    const response = await server.inject({ method: "GET", url: "/__set-cookie-innocent" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).not.toBe("private, no-store");
  });

  it("marks the document private, no-store when a committed cookie (form 1) is replayed onto the response — session fixation: a Set-Cookie response held in a shared cache would hand the SAME cookie to every later visitor", async () => {
    renderPageRequest.mockResolvedValue(
      renderedOk({ cookies: [{ name: "session", value: "abc", options: { raw: true } }] }),
    );

    const response = await server.inject({ method: "GET", url: "/__set-cookie-committed" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("marks the data representation private, no-store for the same committed cookie, so it cannot diverge from the document — the document and data representations of one page route must never disagree on Cache-Control", async () => {
    renderPageRequest.mockResolvedValue(
      renderedOk({ cookies: [{ name: "session", value: "abc", options: { raw: true } }] }),
    );

    const response = await server.inject({
      method: "GET",
      url: "/__set-cookie-committed",
      headers: { [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("marks the document private, no-store when committed headers carry a literal set-cookie key (form 2)", async () => {
    renderPageRequest.mockResolvedValue(
      renderedOk({ headers: { "set-cookie": "literal=value; Path=/" } }),
    );

    const response = await server.inject({ method: "GET", url: "/__set-cookie-literal-header" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("marks the document private, no-store when response.clearCookie() (form 4) runs on the live response before the seam — a deletion is still a Set-Cookie, and it is flushed by the same @fastify/cookie onSend hook as form 1, session fixation applies the same way", async () => {
    renderPageRequest.mockImplementation(
      async (
        _url: string,
        options: { createHttp: () => { response: { clearCookie: (name: string) => void } } },
      ) => {
        const { response } = options.createHttp();
        response.clearCookie("session");
        return renderedOk();
      },
    );

    const response = await server.inject({ method: "GET", url: "/__set-cookie-clear" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
});

/**
 * REGISTRATION ORDER, isolated: proves the floor's `onSend` hook only sees a
 * flushed `Set-Cookie` because it is registered AFTER `@fastify/cookie`'s own
 * `onSend` hook — not because of anything else about the request. Two
 * standalone Fastify instances, differing ONLY in whether
 * `ensureSetCookieCacheFloorHook` is called before or after
 * `registerHttpPlugins` (which registers `@fastify/cookie`). If Fastify's
 * `onSend` order ever stopped being registration order — or if a future edit
 * moved the hook's registration ahead of the cookie plugin's — the
 * "wrong order" case below would start passing its own `not.toBe`, and this
 * test would fail.
 */
describe("Set-Cookie Cache-Control floor — onSend registration order", () => {
  function markAsPageResponseAndSetCookie(
    request: { locals?: { isPageResponse?: boolean } },
    reply: { setCookie: (name: string, value: string, options: Record<string, never>) => void },
  ): void {
    request.locals = { isPageResponse: true };
    reply.setCookie("session", "abc", {});
  }

  it("sees no flushed Set-Cookie, and therefore cannot apply the floor, when its hook is registered BEFORE the cookie plugin (wrong order)", async () => {
    const wrongOrderServer = Fastify();

    ensureSetCookieCacheFloorHook(wrongOrderServer);
    await registerHttpPlugins(wrongOrderServer);

    wrongOrderServer.get("/__wrong-order", async (request, reply) => {
      markAsPageResponseAndSetCookie(request, reply);
      return "ok";
    });

    const response = await wrongOrderServer.inject({ method: "GET", url: "/__wrong-order" });

    // The cookie plugin still ran and still flushed the header — only OUR
    // hook ran too early to see it, which is the entire point of this case.
    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).not.toBe("private, no-store");

    await wrongOrderServer.close();
  });

  it("sees the flushed Set-Cookie and applies the floor when its hook is registered AFTER the cookie plugin (right order)", async () => {
    const rightOrderServer = Fastify();

    await registerHttpPlugins(rightOrderServer);
    ensureSetCookieCacheFloorHook(rightOrderServer);

    rightOrderServer.get("/__right-order", async (request, reply) => {
      markAsPageResponseAndSetCookie(request, reply);
      return "ok";
    });

    const response = await rightOrderServer.inject({ method: "GET", url: "/__right-order" });

    expect(response.headers["set-cookie"]).toBeDefined();
    expect(response.headers["cache-control"]).toBe("private, no-store");

    await rightOrderServer.close();
  });
});
