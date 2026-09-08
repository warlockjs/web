import type { ValidationResult } from "@warlock.js/seal";

/**
 * Raised when a page's `route.validate` schema rejects `{ params, query }`.
 *
 * A page is a document, not an API endpoint (canon `b79c4f55`, point 2): this
 * is thrown into the ordinary error-boundary pipeline rather than answered as
 * a raw JSON body, so the request renders the application's error page (or the
 * nearest authored `ErrorBoundary`) with status 400 instead of a blob of JSON
 * where a page was expected.
 *
 * `errors` stays a real, structured property — never flattened away — so an
 * `error.page.tsx` reading `(error as RouteValidationError).errors` during SSR
 * can say exactly which field was wrong. `message` ALSO summarizes every
 * failing field: SSR (`ServerErrorPageProps.error`) receives this instance
 * directly, but the wire (`serializePageError`, `server/error-page.ts`) keeps
 * only `name`/`message`/`stack` — the same 400 must still say what was wrong
 * after that trip, not just that something was.
 */
export class RouteValidationError extends Error {
  /** Always 400 — a validation failure is the visitor's malformed input, never the server's fault. */
  public readonly statusCode = 400;

  public constructor(public readonly errors: ValidationResult["errors"]) {
    super(
      `Route validation failed: ${errors.map((issue) => `${issue.input}: ${issue.error}`).join("; ")}`,
    );
    this.name = "RouteValidationError";
  }
}
