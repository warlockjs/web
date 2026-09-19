/**
 * The `web.errors` config namespace (card 1db238ca, audit §1.1-1.2) — the ONE
 * app-owned hook a server error is ever handed to, on top of the
 * unconditional `console.error` floor every `reportServerError()` call site
 * already writes (`./report-server-error.ts`).
 *
 * Same mechanism `./streaming-config.ts` already uses for `web.streaming`:
 * `ConfigRegistry` module augmentation lives beside the config it augments
 * (`./streaming-config.ts`), this file only owns the SHAPE — kept separate
 * because the shape is consumed by two unrelated readers
 * (`./report-server-error.ts` for the server hook, `./streaming-config.ts`'s
 * own `WebConfigurations` for the merge) and neither should have to import
 * the other's reader to see it.
 */

/** What kind of server-side failure produced this report. */
export type ServerErrorKind = "render" | "loader" | "defer" | "error-page" | "request-handler";

/**
 * What `web.errors.report()` receives alongside the error itself.
 *
 * Deliberately NEVER carries the raw request URL/query — only `routePath`
 * (the route's own TEMPLATE, e.g. `/posts/:slug`) and `pathname` (the
 * decoded path, no query string) are included, so a query parameter holding
 * a token, a password-reset code or any other secret never reaches an
 * app-owned sink by default (Aria's binding ruling, card 1db238ca). An app
 * that genuinely needs the query string reads it itself, deliberately, from
 * whatever request-scoped state it already has — this hook never hands it
 * over implicitly.
 */
export type ServerErrorContext = {
  kind: ServerErrorKind;
  /** The pipeline stage this failure happened in, e.g. `"render"`, `"page"`, `"rejected"`, `"timeout"`. */
  phase: string;
  /** The matched route's name, when one matched. */
  routeName?: string;
  /** The matched route's own TEMPLATE path (e.g. `/posts/:slug`), never the resolved URL. */
  routePath?: string;
  /** The request's decoded path, WITHOUT its query string. */
  pathname: string;
  /** The request's HTTP method. */
  method: string;
  /** The status the response settled on, when it is already known at report time. */
  statusCode?: number;
  /** Core's per-request correlation id (`Request.id`), when a request is in scope. */
  requestId?: string;
};

/**
 * `web.errors.report` — an app-owned hook for a server-side failure, in
 * ADDITION to the unconditional `console.error` floor
 * (`./report-server-error.ts`), never a replacement for it.
 *
 * Called fire-and-forget, through a bounded queue, and NEVER awaited on the
 * response path — a slow or hanging reporter cannot delay or fail a real
 * HTTP response. A throw or a rejection from this function is caught once,
 * logged once, and never fed back into this same hook (no recursion). See
 * `./report-server-error.ts` for the full contract.
 */
export type WebErrorReportingConfigurations = {
  report?: (error: unknown, context: ServerErrorContext) => void | Promise<void>;
};

/**
 * The decoded path, no query string, off a request-shaped value that MAY be
 * a minimal test double without a real `.path` — reporting context is
 * best-effort, never a reason for a genuine request/render failure's own
 * report to throw a SECOND, unrelated error.
 */
export function pathnameFromRequest(request: { path?: string } | undefined): string {
  if (typeof request?.path !== "string") return "unknown";

  return request.path.split("?")[0] ?? request.path;
}
