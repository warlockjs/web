import type { Request, Response } from "@warlock.js/core";

/**
 * ONE per-request `AbortController`, born where the page request pipeline
 * starts (`execute-page-request.ts`). It aborts when the underlying HTTP
 * request is abandoned — the client disconnected or the socket closed —
 * BEFORE the response finished writing. Listens on the raw Node
 * req/res (`request.baseRequest.raw`, `response.baseResponse.raw`), never on
 * the framework's own `Request`/`Response` wrappers, because those carry no
 * abort/close events of their own.
 *
 * THIS is the signal a later card (a84d0644) reuses to abort the React
 * pipeable stream and deferred writers — keep this module single-purpose:
 * it only decides WHEN a request is abandoned, nothing else.
 *
 * Defensive against a test-constructed `Request`/`Response` that never went
 * through a real HTTP handshake (no `baseRequest`/`baseResponse`): the
 * signal still exists, it simply never fires.
 */
export function createRequestAbortController(
  request: Request,
  response: Response,
): AbortController {
  const controller = new AbortController();
  const rawRequest = request.baseRequest?.raw;
  const rawResponse = response.baseResponse?.raw;

  if (!rawRequest || !rawResponse) return controller;

  const abortIfPending = (): void => {
    if (!rawResponse.writableEnded) controller.abort();
  };

  const cleanup = (): void => {
    rawRequest.off("aborted", abortIfPending);
    rawResponse.off("close", abortIfPending);
    rawResponse.off("finish", cleanup);
  };

  rawRequest.on("aborted", abortIfPending);
  rawResponse.on("close", abortIfPending);
  rawResponse.on("finish", cleanup);

  return controller;
}
