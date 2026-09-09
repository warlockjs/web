import type { PageCacheOptIn } from "../routing/route-identity";
import type { PipelineLoader, PipelineMiddleware } from "./execute-page-request";

/** A page declares either a bare path or a path plus an explicit route name. */
export type PageRouteExport = string | { path: string; name?: string; cache?: PageCacheOptIn };

/** The only export the page installers read off a page module namespace. */
export type PageModuleShape = {
  route?: PageRouteExport;
};

/** The exports the page installers read off a layout module namespace. */
export type LayoutModuleShape = {
  /** Universal registration hook; invoked on this real namespace, never a composed wrapper. */
  register?: () => unknown;
  prefix?: string;
  /** The default export decides whether this layout renders. */
  default?: unknown;
  /** The layout's guards, in declaration order. */
  middleware?: readonly PipelineMiddleware[];
  loader?: PipelineLoader;
};
