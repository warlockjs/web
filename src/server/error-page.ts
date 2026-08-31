import type { SerializedErrorPageProps, SerializedPageError } from "../components/document-context";
import { ERROR_PAGE_METADATA } from "./resolve-page-metadata";
import type { MetadataOutput } from "../metadata";
import type { ServerErrorPageProps } from "../props";

/** Server-only shape of an application-owned `error.page.tsx` namespace. */
export type ErrorPageModule = {
  register?: () => unknown;
  default?: unknown;
  metadata?: MetadataOutput | ((props: ServerErrorPageProps) => MetadataOutput);
};

/** Deliberately lazy: normal requests never even load error.page.tsx. */
export type ErrorPageModuleLoader = () => Promise<ErrorPageModule>;

export function serializePageError(thrown: unknown): SerializedPageError {
  if (thrown instanceof Error) {
    return {
      name: thrown.name || "Error",
      message: thrown.message,
      ...(process.env.NODE_ENV !== "production" && typeof thrown.stack === "string"
        ? { stack: thrown.stack }
        : {}),
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
): SerializedErrorPageProps {
  return { error: serializePageError(serializableError), status: props.status };
}
