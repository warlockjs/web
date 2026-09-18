import { DeferredValueError } from "./runtime/deferred-value-error";

/** A `DeferredValueError`'s own status travels with it; anything else has none to report. */
export function statusOf(error: unknown): number {
  return error instanceof DeferredValueError && typeof error.statusCode === "number"
    ? error.statusCode
    : 500;
}
