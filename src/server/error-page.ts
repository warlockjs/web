import { randomUUID } from "node:crypto";
import { environment } from "@warlock.js/core";
import type { SerializedErrorPageProps, SerializedPageError } from "../components/document-context";
import { ERROR_PAGE_METADATA } from "./resolve-page-metadata";
import type { MetadataOutput } from "../metadata";
import type { ServerErrorPageProps } from "../props";
import { PublicPageError } from "./public-page-error";

/** Server-only shape of an application-owned `error.page.tsx` namespace. */
export type ErrorPageModule = {
  register?: () => unknown;
  default?: unknown;
  metadata?: MetadataOutput | ((props: ServerErrorPageProps) => MetadataOutput);
};

/** Deliberately lazy: normal requests never even load error.page.tsx. */
export type ErrorPageModuleLoader = () => Promise<ErrorPageModule>;

/** The one stable message a real visitor sees for an unexpected production failure. */
export const GENERIC_PRODUCTION_ERROR_MESSAGE = "An unexpected error occurred.";

/**
 * THE chokepoint every browser-bound error — initial HTML/hydration,
 * navigation/NDJSON, and deferred settlements alike — must pass through
 * before it reaches a response. In production, only a {@link PublicPageError}
 * exposes its own `message`; every other thrown value serializes to the same
 * generic message plus an opaque `errorCode` an operator can join against the
 * unconditional server-side report line (`reportServerError`/`reportRenderError`).
 * `stack` never crosses this boundary in production, including for a
 * `PublicPageError`. Development keeps full diagnostics, unchanged.
 *
 * `requestId`, when the caller has one on hand (an in-flight HTTP request),
 * becomes the `errorCode` so it joins the SAME id already carried on
 * `X-Request-Id`/tracing; callers with no request in scope (deferred
 * settlement paths) get a fresh random one instead — still opaque, still
 * joinable through the report line the caller logs alongside it.
 */
export function serializePageError(thrown: unknown, requestId?: string): SerializedPageError {
  if (environment() === "production") {
    if (thrown instanceof PublicPageError) {
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

/** Error-page metadata improves the safe framework default; it cannot remove noindex. */
export function resolveErrorPageMetadata(
  module: ErrorPageModule,
  props: ServerErrorPageProps,
): MetadataOutput {
  const own = typeof module.metadata === "function" ? module.metadata(props) : module.metadata;

  return { ...ERROR_PAGE_METADATA, ...own, robots: own?.robots ?? ERROR_PAGE_METADATA.robots };
}

export function hydrationErrorPageProps(
  props: ServerErrorPageProps,
  serializableError: unknown = props.error,
  requestId?: string,
): SerializedErrorPageProps {
  return { error: serializePageError(serializableError, requestId), status: props.status };
}
