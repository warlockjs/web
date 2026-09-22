/**
 * The web adapter's one call into `WebConnector.boot()` (Part B). Registers
 * `/robots.txt` and, when the sitemap is enabled, `<sitemap path>` plus the
 * shard-file routes. Generation is a startup job: WebConnector runs it after
 * the database connector has started, never from route registration.
 */
import path from "node:path";
import { publicPath, type Router } from "@warlock.js/core";
import { registerRobotsRoute } from "./register-robots-route";
import { registerSitemapRoutes } from "./register-sitemap-routes";
import { regenerateSitemap } from "./sitemap-lifecycle";
import { resolveSitemapConfig } from "./resolve-sitemap-config";

export type RegisterWebHttpRoutesOptions = {
  appRoot?: string;
  warn?: (message: string) => void;
};

export async function registerWebHttpRoutes(
  router: Router,
  options: RegisterWebHttpRoutesOptions = {},
): Promise<void> {
  const warn = options.warn ?? console.warn;
  const publicDir = options.appRoot ? path.join(options.appRoot, "public") : publicPath();

  registerRobotsRoute(router, { publicDir, warn });

  const sitemapConfig = resolveSitemapConfig();

  if (!sitemapConfig.enabled) return;

  registerSitemapRoutes(router, { path: sitemapConfig.path, warn });
}

/**
 * Produces the first sitemap artifact set after all connectors have booted and
 * the database connector has started. `onBoot` remains the user-facing opt-out
 * for this startup job; a failed generation remains non-fatal to app startup.
 */
export async function regenerateSitemapOnStartup(
  options: { appRoot?: string } = {},
): Promise<void> {
  const sitemapConfig = resolveSitemapConfig();

  if (!sitemapConfig.enabled || !sitemapConfig.regenerate.onBoot) return;

  await regenerateSitemap({ appRoot: options.appRoot }).catch(() => undefined);
}
