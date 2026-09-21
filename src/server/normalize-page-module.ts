import { BaseValidator } from "@warlock.js/seal";
import {
  MODULE_CONFIG_KEYS,
  MODULE_EXPORT_NAMES,
  type PageModuleKind,
} from "../module-config-schema";
import {
  METADATA_KEYS,
  OPEN_GRAPH_KEYS,
  TWITTER_KEYS,
  type MetadataOutput,
  type PageMetadata,
} from "../metadata";
import type { PageConfigValidation } from "../page-config";
import type { PageCacheOptIn } from "../routing/route-identity";
import type { SitemapPageExport, SitemapPageOptions } from "../sitemap/sitemap-page-export";
import { readLayoutSitemapDeclaration } from "../sitemap/resolve-layout-sitemap";
import type { PipelineLoader, PipelineMiddleware } from "./execute-page-request.types";

export type { PageModuleKind } from "../module-config-schema";

type PageRoute = string | { readonly path: string; readonly name?: string };

export type NormalizedPageModule = {
  default?: unknown;
  ErrorBoundary?: unknown;
  loader?: PipelineLoader;
  register?: () => unknown;
  route?: PageRoute;
  cache?: PageCacheOptIn;
  middleware?: readonly PipelineMiddleware[];
  validation?: PageConfigValidation;
  metadata?: PageMetadata<PipelineLoader> | { readonly robots?: string };
  sitemap?: SitemapPageExport | false | SitemapPageOptions;
  prefix?: string;
  strictMode?: boolean;
};

const MODULE_EXPORTS = new Set<string>(MODULE_EXPORT_NAMES);
const CACHE_KEYS = new Set(["public", "maxAge", "serverCache", "tags", "varyBy", "ttl"]);
const ROUTE_KEYS = new Set(["path", "name"]);

export class InvalidPageModuleConfigError extends TypeError {
  public constructor(sourceFile: string, detail: string) {
    super(`Invalid ${sourceFile} page module config: ${detail}`);
    this.name = "InvalidPageModuleConfigError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(sourceFile: string, detail: string): never {
  throw new InvalidPageModuleConfigError(sourceFile, detail);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[] | Set<string>,
  sourceFile: string,
  subject: string,
): void {
  const allowedKeys = allowed instanceof Set ? allowed : new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) fail(sourceFile, `${subject} has unknown key(s): ${unknown.join(", ")}.`);
}

function isReactComponentType(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return false;
  const marker = (value as { $$typeof?: unknown }).$$typeof;
  return (
    marker === Symbol.for("react.memo") ||
    marker === Symbol.for("react.forward_ref") ||
    marker === Symbol.for("react.lazy")
  );
}

function validateRoute(value: unknown, sourceFile: string): PageRoute {
  if (typeof value === "string") return value;
  if (!plainObject(value))
    return fail(sourceFile, "config.route must be a string or a plain { path, name? } object.");
  assertExactKeys(value, ROUTE_KEYS, sourceFile, "config.route");
  if (typeof value.path !== "string") fail(sourceFile, "config.route.path must be a string.");
  if (value.name !== undefined && typeof value.name !== "string") {
    fail(sourceFile, "config.route.name must be a string when defined.");
  }
  return value.name === undefined ? { path: value.path } : { path: value.path, name: value.name };
}

function validateCache(value: unknown, sourceFile: string): PageCacheOptIn {
  if (!plainObject(value)) return fail(sourceFile, "config.cache must be a plain object.");
  assertExactKeys(value, CACHE_KEYS, sourceFile, "config.cache");
  if (value.public !== true) fail(sourceFile, "config.cache.public must be true.");
  if (!Number.isFinite(value.maxAge) || typeof value.maxAge !== "number" || value.maxAge < 0) {
    fail(sourceFile, "config.cache.maxAge must be a finite non-negative number.");
  }
  if (value.serverCache !== undefined && typeof value.serverCache !== "boolean") {
    fail(sourceFile, "config.cache.serverCache must be a boolean when defined.");
  }
  if (value.varyBy !== undefined && typeof value.varyBy !== "function") {
    fail(sourceFile, "config.cache.varyBy must be a function when defined.");
  }
  if (
    value.ttl !== undefined &&
    (!Number.isFinite(value.ttl) || typeof value.ttl !== "number" || value.ttl < 0)
  ) {
    fail(sourceFile, "config.cache.ttl must be a finite non-negative number when defined.");
  }
  if (
    value.tags !== undefined &&
    typeof value.tags !== "function" &&
    (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string"))
  ) {
    fail(sourceFile, "config.cache.tags must be a function or an array of strings when defined.");
  }
  if (value.serverCache === true && value.tags === undefined) {
    fail(sourceFile, "config.cache.serverCache requires config.cache.tags.");
  }
  return value as PageCacheOptIn;
}

function validator(
  value: unknown,
  sourceFile: string,
  key: string,
): asserts value is BaseValidator {
  if (!(value instanceof BaseValidator))
    fail(sourceFile, `config.validation.${key} must be a Seal BaseValidator.`);
}

function validateValidation(value: unknown, sourceFile: string): PageConfigValidation {
  if (!plainObject(value)) return fail(sourceFile, "config.validation must be a plain object.");
  assertExactKeys(
    value,
    ["schema", "validating", "params", "query"],
    sourceFile,
    "config.validation",
  );
  const hasSchema = value.schema !== undefined;
  const hasParams = value.params !== undefined;
  const hasQuery = value.query !== undefined;
  if (hasSchema === (hasParams || hasQuery)) {
    fail(
      sourceFile,
      "config.validation must declare either schema or params/query, but not both or neither.",
    );
  }
  if (hasSchema) {
    validator(value.schema, sourceFile, "schema");
    if (
      value.validating !== undefined &&
      (!Array.isArray(value.validating) ||
        !value.validating.every((entry) => typeof entry === "string"))
    ) {
      fail(sourceFile, "config.validation.validating must be an array of strings when defined.");
    }
    return value as PageConfigValidation;
  }
  if (value.validating !== undefined)
    fail(sourceFile, "config.validation.validating is only valid with schema.");
  if (hasParams) validator(value.params, sourceFile, "params");
  if (hasQuery) validator(value.query, sourceFile, "query");
  return value as PageConfigValidation;
}

function validateMiddleware(value: unknown, sourceFile: string): readonly PipelineMiddleware[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "function")) {
    return fail(sourceFile, "config.middleware must be an array of functions.");
  }
  return value as readonly PipelineMiddleware[];
}

function validateLayoutMetadata(value: unknown, sourceFile: string): { readonly robots?: string } {
  if (!plainObject(value))
    return fail(sourceFile, "config.metadata must be a plain static object on a layout.");
  assertExactKeys(value, ["robots"], sourceFile, "config.metadata");
  if (value.robots !== undefined && typeof value.robots !== "string") {
    fail(sourceFile, "config.metadata.robots must be a string when defined.");
  }
  return value as { readonly robots?: string };
}

function validateStringFields(
  value: unknown,
  keys: readonly string[],
  sourceFile: string,
  subject: string,
): void {
  if (!plainObject(value)) fail(sourceFile, `${subject} must be a plain object.`);
  assertExactKeys(value, keys, sourceFile, subject);

  for (const key of keys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      fail(sourceFile, `${subject}.${key} must be a string when defined.`);
    }
  }
}

/** Validate the concrete metadata object that SSR and client navigation consume. */
function validatePageMetadataOutput(value: unknown, sourceFile: string): MetadataOutput {
  if (!plainObject(value)) fail(sourceFile, "config.metadata must return a plain object.");
  assertExactKeys(value, METADATA_KEYS, sourceFile, "config.metadata");

  for (const key of ["title", "description", "canonical", "robots"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      fail(sourceFile, `config.metadata.${key} must be a string when defined.`);
    }
  }
  if (
    value.keywords !== undefined &&
    typeof value.keywords !== "string" &&
    (!Array.isArray(value.keywords) ||
      !value.keywords.every((keyword) => typeof keyword === "string"))
  ) {
    fail(
      sourceFile,
      "config.metadata.keywords must be a string or an array of strings when defined.",
    );
  }
  if (value.openGraph !== undefined) {
    validateStringFields(value.openGraph, OPEN_GRAPH_KEYS, sourceFile, "config.metadata.openGraph");
  }
  if (value.twitter !== undefined) {
    validateStringFields(value.twitter, TWITTER_KEYS, sourceFile, "config.metadata.twitter");
  }

  return value as MetadataOutput;
}

function validatePageMetadata(value: unknown, sourceFile: string): PageMetadata<PipelineLoader> {
  if (typeof value !== "function") return validatePageMetadataOutput(value, sourceFile);

  // Keep metadata evaluation in Stage 8. In particular, a loader-dependent
  // metadata function must not run while routes are installed or modules load.
  return function validatedPageMetadata(this: unknown, context: unknown): MetadataOutput {
    return validatePageMetadataOutput(value.call(this, context), sourceFile);
  } as PageMetadata<PipelineLoader>;
}

function validatePageSitemap(value: unknown, sourceFile: string): SitemapPageExport {
  if (value === false || typeof value === "function") return value as SitemapPageExport;
  // The layout validator owns the static-options grammar. Page suppliers are
  // the only extra page form, handled above.
  return readLayoutSitemapDeclaration(value, sourceFile) as SitemapPageOptions;
}

/**
 * Validate a raw ESM namespace and project config into the existing internal
 * flattened shape. The result is a new object; `raw` is never written to or
 * used as registration identity.
 */
export function normalizePageModule(
  raw: unknown,
  kind: PageModuleKind,
  sourceFile: string,
): NormalizedPageModule {
  if (!plainObject(raw)) fail(sourceFile, "module namespace must be an object.");
  assertExactKeys(raw, MODULE_EXPORTS, sourceFile, "module exports");

  const hasConfig = Object.prototype.hasOwnProperty.call(raw, "config");
  const configValue = hasConfig ? raw.config : {};
  if (!plainObject(configValue))
    fail(sourceFile, "config export must be a plain object when provided.");
  assertExactKeys(configValue, MODULE_CONFIG_KEYS[kind], sourceFile, "config");

  if (raw.loader !== undefined && typeof raw.loader !== "function")
    fail(sourceFile, "loader export must be a function.");
  if (raw.register !== undefined && typeof raw.register !== "function")
    fail(sourceFile, "register export must be a function.");
  if (raw.ErrorBoundary !== undefined && !isReactComponentType(raw.ErrorBoundary)) {
    fail(sourceFile, "ErrorBoundary export must be a React component type.");
  }
  if (kind === "page" && raw.default === undefined)
    fail(sourceFile, "page modules require a default export.");
  if (raw.default !== undefined && !isReactComponentType(raw.default)) {
    fail(sourceFile, "default export must be a React component type.");
  }

  const normalized: NormalizedPageModule = {
    ...(raw.default === undefined ? {} : { default: raw.default }),
    ...(raw.ErrorBoundary === undefined ? {} : { ErrorBoundary: raw.ErrorBoundary }),
    ...(raw.loader === undefined ? {} : { loader: raw.loader as PipelineLoader }),
    ...(raw.register === undefined ? {} : { register: raw.register as () => unknown }),
  };

  if (configValue.middleware !== undefined)
    normalized.middleware = validateMiddleware(configValue.middleware, sourceFile);

  if (kind === "page") {
    if (configValue.route !== undefined)
      normalized.route = validateRoute(configValue.route, sourceFile);
    if (configValue.cache !== undefined)
      normalized.cache = validateCache(configValue.cache, sourceFile);
    if (configValue.validation !== undefined)
      normalized.validation = validateValidation(configValue.validation, sourceFile);
    if (configValue.metadata !== undefined) {
      normalized.metadata = validatePageMetadata(configValue.metadata, sourceFile);
    }
    if (configValue.sitemap !== undefined)
      normalized.sitemap = validatePageSitemap(configValue.sitemap, sourceFile);
  } else if (kind === "layout") {
    if (configValue.prefix !== undefined && typeof configValue.prefix !== "string")
      fail(sourceFile, "config.prefix must be a string.");
    if (configValue.prefix !== undefined) normalized.prefix = configValue.prefix;
    if (configValue.metadata !== undefined)
      normalized.metadata = validateLayoutMetadata(configValue.metadata, sourceFile);
    if (configValue.sitemap !== undefined)
      normalized.sitemap = readLayoutSitemapDeclaration(configValue.sitemap, sourceFile);
  } else if (configValue.strictMode !== undefined) {
    if (typeof configValue.strictMode !== "boolean") {
      fail(sourceFile, "config.strictMode must be a boolean.");
    }
    normalized.strictMode = configValue.strictMode;
  }

  return normalized;
}
