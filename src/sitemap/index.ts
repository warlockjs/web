/**
 * `@warlock.js/web/sitemap` — the sitemap adapter's public surface.
 *
 * Deliberately NOT re-exported from the package root (`../index.ts`): its
 * graph reaches `../build/list-routable-pages`, which imports application
 * page files by path, exactly the reason `listRoutablePages` itself lives on
 * `@warlock.js/web/build` rather than the root barrel. A config file
 * (`src/config/web.ts`) or a build/ops script is the caller; neither needs
 * anything else this barrel would otherwise drag in.
 */
export { generateSitemap } from "./generate-sitemap";
export type { GenerateSitemapOptions } from "./generate-sitemap";
export { MissingPublicUrlError } from "./errors";
export type { SitemapResult } from "./sitemap-result-types";
export type {
  RegeneratePolicy,
  SitemapLocaleConfig,
  WebSitemapConfig,
} from "./sitemap-config-types";
export type { SitemapPageExport, SitemapPageOptions, SitemapPageUrl } from "./sitemap-page-export";
export type { RobotsConfig, RobotsGroup } from "./robots-config-types";

/**
 * Regeneration lifecycle (contract Part 6) — server-only. The application
 * calls this on an event, a schedule, or a TTL when its own dynamic data
 * changed; `warlock build` and production boot already call it via
 * `WebConnector` and the build contribution. Never called from an HTTP
 * request handler — that is what `/sitemap.xml`'s route reads the result of,
 * never what triggers it.
 */
export { regenerateSitemap } from "./sitemap-lifecycle";
export type {
  SitemapArtifacts,
  SitemapArtifactFile,
  SitemapFailure,
  SitemapGenerationResult,
} from "./sitemap-lifecycle";
