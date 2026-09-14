/**
 * Represents a failed top-level page `validation` export (the `{ params,
 * query }` shape, or the legacy `{ schema }` shape) as an ordinary thrown
 * error, carrying the validation issues that caused the failure.
 *
 * It never actually crosses a `throw` boundary — `execute-page-request.ts`
 * constructs one directly, alongside the existing `bundle.shortCircuit`, and
 * hands it to `buildErrorRecord` so a full-document render goes through the
 * exact same boundary / `error.page.tsx` pipeline an ordinary loader throw
 * with its own `statusCode` already takes. The
 * `errors` field is what an authored `error.page.tsx` reads to show what
 * failed.
 */
export class PageValidationFailedError extends Error {
  /** Always 400 — a failed page `validation` is the visitor's malformed input. */
  public readonly statusCode = 400;

  public constructor(public readonly errors: unknown) {
    super("Page validation failed.");
    this.name = "PageValidationFailedError";
  }
}
