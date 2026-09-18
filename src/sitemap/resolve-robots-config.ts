import { config } from "@warlock.js/core";
import { joinOrigin } from "@warlock.js/sitemap";
import { resolveSitemapConfig } from "./resolve-sitemap-config";
import type { RobotsConfig } from "./robots-config-types";

/** `enabled` defaults to `false`, matching `web.sitemap` — no policy is imposed on an app that never opted in. */
export function resolveRobotsConfig(): RobotsConfig {
  const robotsConfig = config.get("web", {}).robots;

  return {
    enabled: robotsConfig?.enabled ?? false,
    referenceSitemap: robotsConfig?.referenceSitemap ?? true,
    groups: robotsConfig?.groups,
    extra: robotsConfig?.extra,
  };
}

/**
 * The absolute URL the `Sitemap:` line should point at, or `undefined` when
 * there is nothing to point at — `web.sitemap.enabled` is `false`, or the
 * sitemap has no origin configured. Never throws: an app that has not wired
 * `app.publicUrl` yet still gets a valid `robots.txt`, just without this line
 * (`generateSitemap()` is the one place a missing origin is a hard failure).
 */
export function resolveSitemapReferenceUrl(): string | undefined {
  const sitemapConfig = resolveSitemapConfig();

  if (!sitemapConfig.enabled || !sitemapConfig.baseUrl) return undefined;

  return joinOrigin(sitemapConfig.baseUrl, sitemapConfig.path);
}
