/**
 * Represents a page middleware short-circuit that never wrote the real HTTP
 * reply itself — the middleware returned a value (`return { message }`, or
 * `return response.setStatusCode(403)` followed by a plain object) instead of
 * calling `response.send()` / `.forbidden()` / `.redirect()` — as an ordinary
 * thrown error, carrying the returned payload and its status.
 *
 * It never actually crosses a `throw` boundary — `render-page.ts`'s
 * `finishRender` constructs one directly, alongside the existing
 * `bundle.shortCircuit`, and hands it to `buildErrorRecord` so a
 * FULL-DOCUMENT render with a >= 400 status goes through the same
 * boundary / `error.page.tsx` pipeline an ordinary loader throw with its own
 * `statusCode` already takes, instead of silently emitting an empty document
 * (the defect this class exists to close). Only built for that one case: a
 * 2xx short-circuit takes a different path entirely (the payload becomes the
 * response body, unchanged — see `finishRender`), and a short-circuit whose
 * real reply is already written (`responseSent: true` — a redirect, or a
 * middleware that called `response.send()` itself) never reaches here.
 */
export class PageMiddlewareShortCircuitError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly payload: unknown,
  ) {
    super("Page middleware short-circuited the request.");
    this.name = "PageMiddlewareShortCircuitError";
  }
}
