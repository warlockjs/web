import { randomUUID } from "node:crypto";
import { environment } from "@warlock.js/core";
import type { SerializedErrorPageProps, SerializedPageError } from "../components/document-context";
import { ERROR_PAGE_METADATA } from "./resolve-page-metadata";
import type { MetadataOutput } from "../metadata";
import type { ServerErrorPageProps } from "../props";
import { normalizePageModule } from "./normalize-page-module";
import { PageValidationFailedError } from "./page-validation-failed-error";
import { isVisitorSafePageError } from "./is-visitor-safe-page-error";

/**
 * One sanitized Seal validation issue: strips every field but
 * `{ input, type, error }`. In production, the `:value` placeholder in
 * page-validation messages renders `…` instead of the submitted value. A
 * custom rule or translation that builds its message from raw input without
 * `:value` isn't covered, so keep submitted values out of custom message
 * text.
 */
type SafeValidationIssue = {
  readonly input: string;
  readonly type: string;
  readonly error: string;
};

/**
 * Picks ONLY `{ input, type, error }` off each raw Seal validation error,
 * dropping every other field a validator might carry (notably the submitted
 * value) before it can reach the browser. Trusts nothing about the shape of
 * `thrown.errors` beyond what it reads here.
 */
function sanitizeValidationIssues(errors: unknown): SafeValidationIssue[] {
  if (!Array.isArray(errors)) return [];

  return errors
    .filter(
      (issue): issue is Record<string, unknown> => typeof issue === "object" && issue !== null,
    )
    .map((issue) => ({
      input: typeof issue.input === "string" ? issue.input : "",
      type: typeof issue.type === "string" ? issue.type : "",
      error: typeof issue.error === "string" ? issue.error : "",
    }));
}

/** Raw server-only namespace of an application-owned `error.page.tsx` module. */
export type ErrorPageModule = Record<string, unknown>;

/** Deliberately lazy: normal requests never even load error.page.tsx. */
export type ErrorPageModuleLoader = () => Promise<ErrorPageModule>;

/** The one stable message a real visitor sees for an unexpected production failure. */
export const GENERIC_PRODUCTION_ERROR_MESSAGE = "An unexpected error occurred.";

/**
 * THE chokepoint every browser-bound error — initial HTML/hydration,
 * navigation/NDJSON, and deferred settlements alike — must pass through
 * before it reaches a response. In production, only a {@link PublicPageError}
 * exposes its own `message`, and a `PageValidationFailedError` (a visitor's
 * malformed input, never a server fault) exposes its own stable message plus
 * `errors` — the field name, rule type and translated rule message for each
 * failed Seal rule. In production, the `:value` placeholder in that message
 * renders `…` instead of the submitted value; a custom rule or translation
 * that builds its message from raw input without `:value` isn't covered, so
 * keep submitted values out of custom message text. Every other thrown value
 * serializes to the same generic message plus an opaque `errorCode` an
 * operator can join against the unconditional server-side report line
 * (`reportServerError`/`reportRenderError`). `stack` never crosses this
 * boundary in production, including for a `PublicPageError` or a
 * `PageValidationFailedError`. Development keeps full diagnostics, unchanged.
 *
 * `requestId`, when the caller has one on hand (an in-flight HTTP request),
 * becomes the `errorCode` so it joins the SAME id already carried on
 * `X-Request-Id`/tracing; callers with no request in scope (deferred
 * settlement paths) get a fresh random one instead — still opaque, still
 * joinable through the report line the caller logs alongside it.
 */
export function serializePageError(thrown: unknown, requestId?: string): SerializedPageError {
  if (thrown instanceof PageValidationFailedError) {
    return {
      name: thrown.name,
      message: thrown.message,
      errors: sanitizeValidationIssues(thrown.errors),
      ...(environment() !== "production" && typeof thrown.stack === "string"
        ? { stack: thrown.stack }
        : {}),
    };
  }

  if (environment() === "production") {
    // A `PublicPageError` and a thrown value that resolves to a 4xx status
    // (a core `HttpError` such as `ForbiddenError`/`BadRequestError`) both
    // keep their own message — `isVisitorSafePageError` is the single answer
    // to "is this the visitor's own affair", shared with `buildErrorRecord`
    // so the two scrub points never disagree.
    if (isVisitorSafePageError(thrown) && thrown instanceof Error) {
      return { name: thrown.name || "Error", message: thrown.message };
    }

    return {
      name: "Error",
      message: GENERIC_PRODUCTION_ERROR_MESSAGE,
      errorCode: requestId || randomUUID(),
    };
  }

  if (thrown instanceof Error) {
    return {
      name: thrown.name || "Error",
      message: thrown.message,
      ...(typeof thrown.stack === "string" ? { stack: thrown.stack } : {}),
    };
  }

  let message: string;
  try {
    message = typeof thrown === "string" ? thrown : String(thrown);
  } catch {
    message = "An unexpected error occurred.";
  }

  return {
    name: "Error",
    message,
  };
}

/**
 * Error-page metadata improves the safe framework default and preserves that
 * default when config omits a field. This is the error page's config ingress:
 * it deliberately accepts a raw namespace so direct callers cannot bypass
 * config-only validation.
 */
export function resolveErrorPageMetadata(
  module: unknown,
  props: ServerErrorPageProps,
): MetadataOutput {
  const normalized = normalizePageModule(module, "page", "error.page.tsx");
  const declared = normalized.metadata;
  const own =
    typeof declared === "function"
      ? // The error page uses error/status context rather than successful loader
        // data. Normalization validates the returned metadata in either case.
        (declared as unknown as (input: ServerErrorPageProps) => MetadataOutput)(props)
      : declared;

  return { ...ERROR_PAGE_METADATA, ...own, robots: own?.robots ?? ERROR_PAGE_METADATA.robots };
}

export function hydrationErrorPageProps(
  props: ServerErrorPageProps,
  serializableError: unknown = props.error,
  requestId?: string,
): SerializedErrorPageProps {
  return { error: serializePageError(serializableError, requestId), status: props.status };
}
