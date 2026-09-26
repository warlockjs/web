import type { Request } from "@warlock.js/core";
import type { SharedContext } from "../index";
import type { LocaleRoutingStrategy } from "../routing/locale-routing";

/** What the host resolver receives: the normalised host and the full request. */
export type HostResolverInput = {
  host: string;
  request: Request;
};

/** A resolver's answer: which dynamic site owns the host, plus per-tenant data. */
export type HostResolution = {
  /** Key of a dynamic site declared in `web.sites`. */
  site: string;
  /** Partition key for caches and per-tenant state, e.g. the tenant id. */
  key: string;
  /** Whether the resolved host may be indexed by crawlers; defaults to not indexable. */
  indexable?: boolean;
  /** Merged into the request's `shared`, so the client reads it through `useShared()`. */
  shared?: Partial<SharedContext>;
};

/** Returns the resolution, or `null` for a controlled 404. A throw is a 500. */
export type HostResolver = (
  input: HostResolverInput,
) => Promise<HostResolution | null> | HostResolution | null;

type SiteLocaleRouting = { strategy?: LocaleRoutingStrategy };

/** A site served on an explicit list of exact hostnames. */
export type FixedSiteConfig = {
  /** Route-group folder directly under `src/web`, e.g. `"(landing)"`. */
  pages: string;
  /** Exact lowercase hostnames without port; `www.` is an alias only when listed. */
  hosts: string[];
  /** Path prefix the whole site lives under on its hosts, e.g. `"/admin"`. */
  basePath?: string;
  /** Overrides the global `web.localeRouting` for this site. */
  localeRouting?: SiteLocaleRouting;
};

/** A site whose hosts are claimed at runtime by `web.resolveHost`. */
export type DynamicSiteConfig = {
  /** Route-group folder directly under `src/web`, e.g. `"(tenant)"`. */
  pages: string;
  dynamic: true;
  /** Path prefix the whole site lives under on its hosts, e.g. `"/admin"`. */
  basePath?: string;
  /** Overrides the global `web.localeRouting` for this site. */
  localeRouting?: SiteLocaleRouting;
};

export type SiteConfig = FixedSiteConfig | DynamicSiteConfig;

/** `web.sites`, keyed by site key. */
export type SitesConfig = Record<string, SiteConfig>;
