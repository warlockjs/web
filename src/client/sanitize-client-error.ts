import type { SerializedPageError } from "../hydration-payload";
import { DeferredValueError } from "./runtime/deferred-value-error";

/** The one stable message a real visitor sees for an unexpected production failure. */
const GENERIC_PRODUCTION_ERROR_MESSAGE = "An unexpected error occurred.";

/**
 * The client-side counterpart of `server/error-page.ts`'s `serializePageError`.
 * Same redaction rule — in production, only a value this floor already knows
 * came through the server's OWN redaction is shown, everything else collapses
 * to the generic message; development keeps full diagnostics.
 *
 * A caught {@link DeferredValueError} is that known-safe case: its `message`
 * is never the original thrown value — `defer-registry.ts` builds it only
 * from the wire-safe settlement shape `serializePageError` already produced
 * server-side (`defer-settlement.ts`'s `toSettlementError`) — so re-redacting
 * it here would only replace an already-safe message with a less useful one.
 * `PublicPageError` has no client-side counterpart: it is thrown only from
 * server-owned loaders/middleware and never reaches a client `throw`.
 */
export function sanitizeClientError(error: unknown): SerializedPageError {
  if (error instanceof DeferredValueError) {
    return { name: error.name, message: error.message };
  }

  if (!import.meta.env?.DEV) {
    return { name: "Error", message: GENERIC_PRODUCTION_ERROR_MESSAGE };
  }

  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }

  let message: string;

  try {
    message = typeof error === "string" ? error : String(error);
  } catch {
    message = GENERIC_PRODUCTION_ERROR_MESSAGE;
  }

  return { name: "Error", message };
}
