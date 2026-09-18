/**
 * The web adapter's one call into `WebConnector.boot()` (Part B). Registers
 * `/robots.txt` and, when the sitemap is enabled, `<sitemap path>` plus the
 * shard-file routes — then, unless `regenerate.onBoot` is `false`, triggers
 * the first generation so there is something to serve.
 *
 * Generation happens here, at boot, never inside a route handler — Part 6
 * rule 1/5.
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

  if (sitemapConfig.regenerate.onBoot) {
    // Awaited: Part 6 rule 1 is "build/start PRODUCES an artifact set", not
    // "kicks one off". Failure must not fail the boot, though — the app
    // still has to come up and serve everything else; `regenerateSitemap`
    // already reported the error unconditionally, and requests fall to the
    // 503 path (Part 6 rule 5) until a later regeneration succeeds.
    await regenerateSitemap({ appRoot: options.appRoot }).catch(() => undefined);
  }
}
