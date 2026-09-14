import { Response, type Request } from "@warlock.js/core";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { connectPageContext, type PageRouteEntry } from "./execute-page-request";
import { renderPageRequest } from "./render-page";
import type { ErrorPageModule } from "./error-page";

/**
 * A page middleware short-circuit (`triple.<level>.middleware` returning a
 * value instead of `undefined`) used to always answer a FULL-DOCUMENT
 * request with an empty document — `execute-page-request.ts` records the
 * returned value on `bundle.shortCircuit`, but `render-page.ts`'s
 * `finishRender` only ever read the `statusCode` off it and returned
 * `{ html: "", ... }`. For a middleware that never touches the real HTTP
 * reply itself (`return { message }`, or `response.setStatusCode(403)`
 * followed by a plain object) that silently threw away the visitor's answer.
 *
 * REPRODUCTION (recorded once, driving the REAL `Response` class from
 * `@warlock.js/core` wired to a minimal fake Fastify reply, so
 * `response.send()`/`.forbidden()`/`.redirect()` run their real,
 * wire-writing implementation — not a test double):
 *
 * | case                              | real reply (what the client got)      | old `renderPageRequest` html/status |
 * |------------------------------------|----------------------------------------|--------------------------------------|
 * | (a) `response.redirect('/login')`  | sent=true, 302, Location: /login       | html:"", status:200 (unused — reply already sent) |
 * | (b) `response.forbidden({error})`  | sent=true, 403, body `{error:"nope"}`  | html:"", status:403 (unused — reply already sent) |
 * | (c) `return { message }` (2xx)     | **sent=false — NOTHING delivered**     | html:"", status:200 — **silently empty** |
 * | (e) `setStatusCode(403)` + object  | **sent=false — NOTHING delivered**     | html:"", status:403 — **silently empty** |
 * | (d) `return undefined` (continue)  | n/a — loader runs, page renders        | ordinary rendered document |
 *
 * (a) and (b) are NOT broken: the middleware already wrote the real reply
 * (`Response.sent === true`) before the pipeline ever inspects its return
 * value, so the client already has the correct answer — the pipeline's own
 * `html: ""` is dead weight, discarded by `Response.send()`'s own
 * already-sent guard. (c) and (e) ARE broken: the middleware never touched
 * the live response, so `Response.sent === false`, and the returned payload
 * had no other way to reach the client.
 *
 * DECIDED FIX: `bundle.shortCircuit` (middleware stage) now also carries
 * `responseSent` (`Response.sent`, read right after the middleware resolved).
 * `finishRender` renders the empty-body branch ONLY when `responseSent` is
 * true (or the request is a DATA request — untouched, byte-identical
 * contract). Otherwise: a >= 400 status renders the ordinary
 * boundary/`error.page.tsx` pipeline via a new `PageMiddlewareShortCircuitError`
 * (mirrors how a failed `validation` already routes through
 * `PageValidationFailedError`); a 2xx status sends the middleware's own
 * returned value as the body, unchanged.
 */

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

/** A minimal stand-in for Fastify's `FastifyReply` — just enough surface for `Response`. */
function createFakeBaseResponse() {
  const headerMap: Record<string, string> = {};
  let sentBody: unknown;
  let sentStatus: number | undefined;
  let sent = false;

  const fake = {
    get sent() {
      return sent;
    },
    get statusCode() {
      return sentStatus ?? 200;
    },
    status(code: number) {
      sentStatus = code;
      return fake;
    },
    header(key: string, value: unknown) {
      headerMap[key] = String(value);
      return fake;
    },
    headers(bag: Record<string, unknown>) {
      for (const [key, value] of Object.entries(bag)) headerMap[key] = String(value);
      return fake;
    },
    getHeader(key: string) {
      return headerMap[key];
    },
    getHeaders() {
      return headerMap;
    },
    removeHeader(key: string) {
      delete headerMap[key];
      return fake;
    },
    async send(body: unknown) {
      sentBody = body;
      sent = true;
      return fake;
    },
    redirect(url: string, statusCode = 302) {
      headerMap["location"] = url;
      sentStatus = statusCode;
      sent = true;
      return fake;
    },
    raw: {
      once() {
        // no-op — `Response.setResponse` listens for "finish"; never fired here.
      },
      write() {},
      end() {},
      writeHead() {},
      on() {},
    },
  };

  return {
    fake,
    readSent: () => ({ sent, sentStatus, sentBody, headers: { ...headerMap } }),
  };
}

/** Wires a real core `Response` to a fake reply, and a minimal `Request`. */
function createHttp() {
  const { fake, readSent } = createFakeBaseResponse();
  const response = new Response();
  response.setResponse(fake as never);
  const request = { nonce: undefined, locale: "en", path: "/orders/1" } as unknown as Request;

  return { request, response, readSent };
}

function pageEntry(middleware: PageRouteEntry["triple"]["page"]["middleware"]): PageRouteEntry {
  return {
    path: "/orders/1",
    name: "orders.details",
    triple: {
      app: {},
      layout: {},
      page: {
        middleware,
        loader: () => ({ reached: "loader" }),
        default: () => createElement("main", {}, "page body"),
      },
    },
  };
}

function fakeErrorPageModule(): ErrorPageModule {
  return {
    default: ({ error }: { error: unknown }) =>
      createElement("main", { role: "alert" }, String((error as Error)?.message ?? error)),
  };
}

describe("page middleware short-circuit — full-document request", () => {
  it("CONTROL (a): a committed redirect keeps today's behaviour — real reply already correct", async () => {
    const { request, response, readSent } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [pageEntry([({ response: httpResponse }) => httpResponse.redirect("/login")])],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.html).toBe("");
    expect(readSent()).toMatchObject({
      sent: true,
      sentStatus: 302,
      headers: { location: "/login" },
    });
  });

  it("CONTROL (b): a middleware that sends its own reply (forbidden) keeps today's behaviour", async () => {
    const { request, response, readSent } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [
        pageEntry([({ response: httpResponse }) => httpResponse.forbidden({ error: "nope" })]),
      ],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.html).toBe("");
    expect(readSent()).toMatchObject({
      sent: true,
      sentStatus: 403,
      sentBody: { error: "nope" },
    });
  });

  it("FIXED (c): a 2xx short-circuit that never sent sends the payload as the body, unchanged", async () => {
    const { request, response, readSent } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [pageEntry([() => ({ message: "guarded" })])],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(readSent().sent).toBe(false);
    expect(rendered.status).toBe(200);
    expect(rendered.html).toBe(JSON.stringify({ message: "guarded" }));
  });

  it("FIXED (e): a >= 400 short-circuit that never sent renders the error boundary, not an empty document", async () => {
    const { request, response, readSent } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [
        pageEntry([
          ({ response: httpResponse }) => {
            httpResponse.setStatusCode(403);
            return { error: "nope" };
          },
        ]),
      ],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(readSent().sent).toBe(false);
    expect(rendered.status).toBe(403);
    expect(rendered.html).not.toBe("");
    expect(rendered.html).toContain("Page middleware short-circuited the request.");
  });

  it("(d) continue: an ordinary middleware that returns nothing renders the page normally", async () => {
    const { request, response } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [pageEntry([() => undefined])],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.status).toBe(200);
    expect(rendered.html).toContain("page body");
  });
});

describe("page middleware short-circuit — DATA (client-navigation) request, byte-identical contract", () => {
  it("a 2xx short-circuit that never sent keeps the untouched empty-body contract on a data request", async () => {
    const { request, response } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [pageEntry([() => ({ message: "guarded" })])],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
      dataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.html).toBe("");
    expect(rendered.status).toBe(200);
    expect(rendered.bundle?.shortCircuit).toMatchObject({
      stage: "middleware",
      value: { message: "guarded" },
    });
  });

  it("a >= 400 short-circuit that never sent keeps the untouched empty-body contract on a data request", async () => {
    const { request, response } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [
        pageEntry([
          ({ response: httpResponse }) => {
            httpResponse.setStatusCode(403);
            return { error: "nope" };
          },
        ]),
      ],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
      dataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.html).toBe("");
    expect(rendered.status).toBe(403);
    expect(rendered.bundle?.shortCircuit).toMatchObject({ stage: "middleware", statusCode: 403 });
  });

  it("a committed redirect keeps the untouched empty-body contract on a data request", async () => {
    const { request, response } = createHttp();
    const rendered = await renderPageRequest("/orders/1", {
      routes: [pageEntry([({ response: httpResponse }) => httpResponse.redirect("/login")])],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
      dataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.html).toBe("");
  });
});
