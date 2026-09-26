import type { Request } from "@warlock.js/core";
import type { LocaleRoutingStrategy } from "./routing/locale-routing";
import type { RobotsConfig } from "./sitemap/robots-config-types";
import type { WebSitemapConfig } from "./sitemap/sitemap-config-types";
import type { WebErrorReportingConfigurations } from "./server/error-reporting-config";
import type { SessionResolver } from "./session/session.types";
import type { HostResolver, SitesConfig } from "./sites/site-config.types";

/** Customises crawler detection for the fully resolved-document renderer. */
export type CrawlerDetectionOptions = {
  /** Replaces the built-in list; spread the defaults explicitly when extending it. */
  userAgents?: readonly RegExp[];
  /** Takes precedence over `userAgents` when provided. */
  detect?: (request: Request) => boolean;
};

/** Streaming SSR controls under the application's `web.streaming` configuration. */
export type WebStreamingConfigurations = {
  /** `false` disables crawler detection; omitted uses the built-in user-agent list. */
  crawlers?: false | CrawlerDetectionOptions;
  /** Milliseconds a single deferred value may take to settle. */
  deferTimeout?: number;
};

/** Application-owned configuration for the Web connector's server features. */
export type WebConfigurations = {
  streaming?: WebStreamingConfigurations;
  /** Milliseconds for the non-deferred app → layout → page loader chain; `0` disables it. */
  loaderTimeout?: number;
  sitemap?: WebSitemapConfig;
  robots?: RobotsConfig;
  localeRouting?: { strategy?: LocaleRoutingStrategy };
  errors?: WebErrorReportingConfigurations;
  /** Resolves the signed-in user for pages, e.g. auth's `pageSession()`. */
  session?: SessionResolver;
  /** Opt-in multi-site mode: several sites (fixed hosts or resolver-driven) in one app. */
  sites?: SitesConfig;
  /** Maps a request host to a dynamic site; `null` means unknown host. */
  resolveHost?: HostResolver;
  /** Opt-in memoisation of `resolveHost`, keyed by host ONLY; `ttl` in seconds. */
  resolveCache?: { ttl: number };
  /** What an unmatched host gets: a plain 404 (default) or the key of a fallback site. */
  unknownHost?: "not-found" | string;
  /** Path of the opt-in Caddy on-demand TLS `ask` endpoint, e.g. `/.well-known/warlock/domain`. */
  tlsAsk?: string;
};
