import type { Request } from "@warlock.js/core";
import type { LocaleRoutingStrategy } from "./routing/locale-routing";
import type { RobotsConfig } from "./sitemap/robots-config-types";
import type { WebSitemapConfig } from "./sitemap/sitemap-config-types";
import type { WebErrorReportingConfigurations } from "./server/error-reporting-config";

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
};
