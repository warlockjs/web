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
import { startSitemapRuntime } from "./sitemap-lifecycle";
import { resolveSitemapConfig } from "./resolve-sitemap-config";

export type RegisterWebHttpRoutesOptions = {
  appRoot?: string;
  warn?: (message: string) => void;
  /** Production manifest `publicFiles`; decides shipped robots.txt / sitemap file collisions. */
  publicFiles?: readonly string[];
};

export async function registerWebHttpRoutes(
  router: Router,
  options: RegisterWebHttpRoutesOptions = {},
): Promise<void> {
  const warn = options.warn ?? console.warn;
  const publicDir = options.appRoot ? path.join(options.appRoot, "public") : publicPath();

  registerRobotsRoute(router, { publicDir, warn, publicFiles: options.publicFiles });

  const sitemapConfig = resolveSitemapConfig();

  if (!sitemapConfig.enabled) return;

  if (options.publicFiles?.includes(sitemapConfig.path.replace(/^\/+/, ""))) {
    warn(
      `[warlock:web] public/${sitemapConfig.path.replace(/^\/+/, "")} is shipped with the build — ` +
        "web will not register the sitemap routes.",
    );
    return;
  }

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
  if (!resolveSitemapConfig().enabled) return;
  // Restoration/subscriptions happen even when onBoot generation is disabled.
  // startSitemapRuntime already logs via reportFailure; startup stays non-fatal.
  await startSitemapRuntime({ appRoot: options.appRoot }).catch(() => undefined);
}
