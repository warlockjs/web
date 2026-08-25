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
import { Request, requestContext, Response } from "@warlock.js/core";

export { requestContext, Request, Response };

/**
 * The reply stand-in is a RECORDER, not a no-op.
 *
 * Every method below either records or is fastify's real behaviour written
 * out. That matters because the members core's terminal paths reach for —
 * `send`, `redirect`, `status`, `sent` — are exactly the ones that write to
 * the socket in production. A shim that swallows them makes the harness
 * disagree with production in the one direction a spec can never catch: it
 * reports "nothing happened" for a call that already flushed the response.
 *
 * `redirect()` in particular used to be `() => shim`. That is why no spec ever
 * noticed that a loader redirect on the document path emits no `Location`
 * (design/loader-endpoint-seam-2026-08-23.md §5, §7) — the only surface that
 * could have told the truth had been silenced.
 *
 * NOTE on the field name: the recorded header bag is `appliedHeaders`, not
 * `headers`. Fastify's own reply exposes `headers(object)` as a METHOD
 * (`Response.headers()`, core/src/http/response.ts:910-914, calls straight
 * through to it), so the bag cannot also own that key.
 */
export type ReplyShim = {
  /**
   * `Response.setResponse` subscribes to `raw.once("finish")` for timing
   * (core/src/http/response.ts:200-205) — the same member core's own unit
   * shim carries (`concurrency-limit.middleware.test.ts:27,41`:
   * `baseResponse: { raw: EventEmitter }`).
   */
  raw: EventEmitter;
  /** Applied headers, lowercased key → value. */
  appliedHeaders: Record<string, unknown>;
  /** Applied cookies in application order (fastify's setCookie signature). */
  cookies: { name: string; value: string; options?: Record<string, unknown> }[];
  /**
   * Fastify's own flag. `Response.send` reads it as its double-send guard
   * (response.ts:371-379) — so a shim that never sets it lets a spec send
   * twice and see both.
   */
  sent: boolean;
  /** Last status handed to `status()` / `redirect()`; fastify defaults to 200. */
  statusCode: number;
  /** Every payload handed to `send()`, in order. */
  payloads: unknown[];
  /** Every `redirect()` call, in order — the record §7 says must exist. */
  redirects: { url: string; statusCode: number }[];
  header(key: string, value: unknown): ReplyShim;
  headers(headers: Record<string, unknown>): ReplyShim;
  getHeader(key: string): unknown;
  getHeaders(): Record<string, unknown>;
  removeHeader(key: string): ReplyShim;
  setCookie(name: string, value: string, options?: Record<string, unknown>): ReplyShim;
  status(statusCode: number): ReplyShim;
  send(payload?: unknown): ReplyShim;
  redirect(url: string, statusCode?: number): ReplyShim;
};

export function createReplyShim(): ReplyShim {
  const shim: ReplyShim = {
    raw: new EventEmitter(),
    appliedHeaders: {},
    cookies: [],
    sent: false,
    statusCode: 200,
    payloads: [],
    redirects: [],

    header(key, value) {
      shim.appliedHeaders[key.toLowerCase()] = value;
      return shim;
    },

    headers(headers) {
      for (const [key, value] of Object.entries(headers)) shim.header(key, value);
      return shim;
    },

    getHeader(key) {
      return shim.appliedHeaders[key.toLowerCase()];
    },

    getHeaders() {
      return { ...shim.appliedHeaders };
    },

    removeHeader(key) {
      delete shim.appliedHeaders[key.toLowerCase()];
      return shim;
    },

    setCookie(name, value, options) {
      shim.cookies.push({ name, value, options });
      return shim;
    },

    status(statusCode) {
      shim.statusCode = statusCode;
      return shim;
    },

    send(payload) {
      shim.payloads.push(payload);
      shim.sent = true;
      return shim;
    },

    /**
     * Fastify's `reply.redirect(url, code)` sets `Location`, sets the status,
     * and SENDS. All three are recorded here; `sent` is the one that makes a
     * middleware redirect stop looking harmless in a spec.
     */
    redirect(url, statusCode = 302) {
      shim.redirects.push({ url, statusCode });
      shim.appliedHeaders.location = url;
      shim.statusCode = statusCode;
      shim.sent = true;
      return shim;
    },
  };

  return shim;
}

export function createFastifyRequestShim(input: {
  url: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  return {
    url: input.url,
    method: "GET",
    params: input.params ?? {},
    query: input.query ?? {},
    body: {},
    headers: input.headers ?? {},
  };
}

export function createCoreHttp(input: {
  url: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
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
