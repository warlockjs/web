import type { BaseValidator } from "@warlock.js/seal";
import type { MetadataOutput, PageMetadata } from "./metadata";
import type { LoaderFunction } from "./props";
import type { RouteDeclaration } from "./route";
import type { PageCacheOptIn } from "./routing/route-identity";
import type { PipelineMiddleware } from "./server/execute-page-request.types";
import type { SitemapPageExport, SitemapPageOptions } from "./sitemap/sitemap-page-export";

/**
 * The validation forms accepted by a page's `config` export.
 * A whole-request schema and separate params/query schemas are alternatives.
 */
export type PageConfigValidation =
  | {
      readonly schema: BaseValidator;
      readonly validating?: readonly string[];
      readonly params?: never;
      readonly query?: never;
    }
  | {
      readonly params: BaseValidator;
      readonly query?: BaseValidator;
      readonly schema?: never;
      readonly validating?: never;
    }
  | {
      readonly params?: BaseValidator;
      readonly query: BaseValidator;
      readonly schema?: never;
      readonly validating?: never;
    };

/** Props of a page-owned, named server-rendered `ErrorBoundary` component. */
export type PageErrorBoundaryProps = { readonly error: unknown };

/**
 * Server/build policy for a page's single `config` export.
 *
 * `loader`, `register`, `ErrorBoundary`, and the default component stay
 * separate exports. `ErrorBoundary` is a component, not a config setting.
 * Every field is read on the server or during build. The client receives
 * resolved metadata and route data, not this object.
 */
export type PageConfig<TLoader extends LoaderFunction | undefined = undefined> = {
  /** An explicit literal URL declaration; omission uses the filesystem route. */
  readonly route?: RouteDeclaration;
  /** Response and server-cache policy; independent of URL identity. */
  readonly cache?: PageCacheOptIn;
  /** Page guards run after ancestor guards. */
  readonly middleware?: readonly PipelineMiddleware[];
  /** Request input validated before the page loader runs. */
  readonly validation?: PageConfigValidation;
  /** Resolved after a successful loader, using its concrete return type. */
  readonly metadata?: PageMetadata<TLoader>;
  /** Page sitemap policy or dynamic URL supplier. */
  readonly sitemap?: SitemapPageExport;
};

/**
 * Settings for one positional layout. A layout can set a URL
 * prefix and inherited crawl defaults, but cannot declare a page route,
 * page cache policy, request validation, or sitemap URL supplier.
 */
export type LayoutConfig = {
  /** A literal URL prefix composed with descendant page paths. */
  readonly prefix?: string;
  /** Guards inherited by descendant pages, outermost layout first. */
  readonly middleware?: readonly PipelineMiddleware[];
  /** Nearest-layout sitemap default; a supplier function is page-only. */
  readonly sitemap?: false | SitemapPageOptions;
  /** HTML robots default; unrelated page metadata fields do not clear it. */
  readonly metadata?: { readonly robots?: NonNullable<MetadataOutput["robots"]> };
};

/**
 * Root settings. The root has no URL identity or prefix; sitewide
 * robots.txt and sitemap generation stay in global web configuration.
 */
export type RootConfig = {
  /** App guards run before layout and page guards. */
  readonly middleware?: readonly PipelineMiddleware[];
};
