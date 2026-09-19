import { PageValidationFailedError } from "./page-validation-failed-error";
import { PublicPageError } from "./public-page-error";

/**
 * True for the errors whose content is meant for the visitor and so survives
 * production scrubbing: a `PublicPageError` (its message) and a
 * `PageValidationFailedError` (the visitor's own bad input, never a server
 * fault). Both production scrub points — `buildErrorRecord` and
 * `serializePageError` — ask this one question, so they can never disagree.
 */
export function isVisitorSafePageError(thrown: unknown): boolean {
  return thrown instanceof PublicPageError || thrown instanceof PageValidationFailedError;
}
