import { PageValidationFailedError } from "./page-validation-failed-error";
import { PublicPageError } from "./public-page-error";
import { resolveCoreHttpErrorStatus } from "./resolve-thrown-http-status";

/**
 * True for the errors whose content is meant for the visitor and so survives
 * production scrubbing: a `PublicPageError` (its message), a
 * `PageValidationFailedError` (the visitor's own bad input, never a server
 * fault), and any other thrown value that resolves to a 4xx status (a core
 * `@warlock.js/core` `HttpError` such as `ForbiddenError`/`BadRequestError`,
 * or an app error following the same convention) — the visitor's own affair,
 * not a server fault, so it gets the same real-message treatment. Both
 * production scrub points — `buildErrorRecord` and `serializePageError` —
 * ask this one question, so they can never disagree.
 */
export function isVisitorSafePageError(thrown: unknown): boolean {
  if (thrown instanceof PublicPageError || thrown instanceof PageValidationFailedError) return true;

  const status = resolveCoreHttpErrorStatus(thrown);
  return status !== undefined && status >= 400 && status <= 499;
}
