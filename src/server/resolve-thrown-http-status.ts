import { HttpError } from "@warlock.js/core";

/**
 * Resolves the numeric HTTP status (400-599) a thrown value carries, so a
 * loader/middleware throw is classified by the failure's own status instead
 * of always falling through to a generic 500.
 *
 * Two sources, checked in order:
 *
 *   1. `thrown.statusCode` — what the framework's own loader-boundary errors
 *      already carry (`PageLoaderTimeoutError`, `PageValidationFailedError`,
 *      `PageMiddlewareShortCircuitError`).
 *   2. `thrown.status` — what `@warlock.js/core`'s `HttpError` (and its
 *      subclasses: `ResourceNotFoundError` 404, `UnAuthorizedError`,
 *      `ForbiddenError`, `BadRequestError`, `ConflictError`, `ServerError`,
 *      …) carries instead.
 *
 * `web` already depends on `@warlock.js/core` directly (not as an optional
 * peer), so `HttpError` could be imported here and matched with
 * `instanceof`. Duck-typing is used instead: a workspace can end up with two
 * resolved copies of `@warlock.js/core` (the app's own dependency graph vs.
 * the one this package's `node_modules` resolves), which breaks
 * `instanceof` across that boundary even for a genuine `HttpError` instance.
 * So the check walks the prototype chain for a class NAMED `HttpError`
 * (resilient to that split) and reads its numeric `status`. It is not a
 * plain "has a numeric status" check: third-party errors carry one too
 * (`AxiosError.status` is the UPSTREAM response's status), and an upstream
 * 404/401 must not become this page's 404/401 or leak its message.
 */
export function resolveThrownHttpStatus(thrown: unknown): number | undefined {
  const withStatusCode = thrown as { statusCode?: unknown } | null;

  if (
    typeof withStatusCode?.statusCode === "number" &&
    isHttpErrorStatus(withStatusCode.statusCode)
  ) {
    return withStatusCode.statusCode;
  }

  return resolveCoreHttpErrorStatus(thrown);
}

/**
 * The narrower half of {@link resolveThrownHttpStatus}: only the
 * core-`HttpError`-shaped `.status` duck type, never the framework's own
 * internal `.statusCode` carriers (`PageLoaderTimeoutError`,
 * `PageValidationFailedError`, `PageMiddlewareShortCircuitError`). Exported
 * on its own because `isVisitorSafePageError` needs exactly this narrower
 * question — "does this look like a genuine core HttpError" — and must NOT
 * treat an arbitrary internal `.statusCode` carrier as visitor-safe by
 * shape alone; those decide their own visitor-safety explicitly, by class.
 */
export function resolveCoreHttpErrorStatus(thrown: unknown): number | undefined {
  // `instanceof` covers the single-copy case even when a bundle has mangled
  // class names; the name walk covers two resolved copies of core.
  const isHttpError =
    thrown instanceof HttpError ||
    (thrown instanceof Error && extendsClassNamed(thrown, "HttpError"));

  if (!isHttpError) return undefined;

  const withStatus = thrown as Error & { status?: unknown };

  if (typeof withStatus.status === "number" && isHttpErrorStatus(withStatus.status)) {
    return withStatus.status;
  }

  return undefined;
}

/** Whether any constructor in `value`'s prototype chain is named `className`. */
function extendsClassNamed(value: object, className: string): boolean {
  for (
    let proto = Object.getPrototypeOf(value);
    proto !== null;
    proto = Object.getPrototypeOf(proto)
  ) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === className) return true;
  }

  return false;
}

function isHttpErrorStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}
