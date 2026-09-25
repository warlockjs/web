/** Shared source/runtime surface for page, layout, and document modules. */
export type PageModuleKind = "page" | "layout" | "root";

export const MODULE_EXPORT_NAMES = [
  "config",
  "loader",
  "register",
  "action",
  "actions",
  "ErrorBoundary",
  "default",
] as const;

export const MODULE_CONFIG_KEYS = {
  page: ["route", "cache", "middleware", "validation", "metadata", "sitemap", "action", "actions"],
  layout: ["prefix", "middleware", "metadata", "sitemap"],
  root: ["middleware", "strictMode", "metadata"],
} as const satisfies Record<PageModuleKind, readonly string[]>;
