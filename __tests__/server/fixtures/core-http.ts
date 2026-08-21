/**
 * REAL core Request/Response construction for the pipeline specs.
 *
 * This is deliberately not a hand mock of core's classes: `createCoreHttp`
 * performs the same five wiring lines core's own route handler performs
 * (core/src/router/router.ts:924-932 — `new Request()`, `new Response()`,
 * `setResponse`, the two cross-links, `setRequest`), against the real classes
 * imported from core's source. What IS shimmed is exactly what core cannot
 * construct without a live server: the fastify request/reply pair — the same
 * boundary core's own unit suite draws (`tests/unit/http/response-helpers.test.ts:5-9`
 * leaves "everything that calls send()" to integration tests, and
 * `cache-response-middleware.test.ts:59` / `concurrency-limit.middleware.test.ts:27-41`
 * stub `baseResponse` with plain objects when a reply surface is needed).
 *
 * `request.setRoute()` (router.ts:932's second half) is NOT called: it needs a
 * core `Route`, and the page triple is matched by the pipeline itself — the
 * page pipeline's stage 1 replaces fastify's matcher here.
 */
import { EventEmitter } from "node:events";
import { requestContext } from "../../../../core/src/http/context/request-context";
import { Request } from "../../../../core/src/http/request";
import { Response } from "../../../../core/src/http/response";

export { requestContext, Request, Response };

export type ReplyShim = {
  /**
   * `Response.setResponse` subscribes to `raw.once("finish")` for timing
   * (core/src/http/response.ts:200-205) — the same member core's own unit
   * shim carries (`concurrency-limit.middleware.test.ts:27,41`:
   * `baseResponse: { raw: EventEmitter }`).
   */
  raw: EventEmitter;
  /** Applied headers, lowercased key → value. */
  headers: Record<string, unknown>;
  /** Applied cookies in application order (fastify's setCookie signature). */
  cookies: { name: string; value: string; options?: Record<string, unknown> }[];
  header(key: string, value: unknown): ReplyShim;
  setCookie(name: string, value: string, options?: Record<string, unknown>): ReplyShim;
  redirect(url: string, statusCode?: number): ReplyShim;
};

export function createReplyShim(): ReplyShim {
  const shim: ReplyShim = {
    raw: new EventEmitter(),
    headers: {},
    cookies: [],

    header(key, value) {
      shim.headers[key.toLowerCase()] = value;
      return shim;
    },

    setCookie(name, value, options) {
      shim.cookies.push({ name, value, options });
      return shim;
    },

    redirect() {
      return shim;
    },
  };

  return shim;
}

export function createFastifyRequestShim(input: {
  url: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
}) {
  return {
    url: input.url,
    method: "GET",
    params: input.params ?? {},
    query: input.query ?? {},
    body: {},
    headers: {},
  };
}

export function createCoreHttp(input: {
  url: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const request = new Request();
  const response = new Response();
  const reply = createReplyShim();

  response.setResponse(reply as any); // router.ts:927
  (request as any).response = response; // router.ts:928
  (response as any).request = request; // router.ts:930
  request.setRequest(createFastifyRequestShim(input) as any); // router.ts:932

  return { request, response, reply };
}
