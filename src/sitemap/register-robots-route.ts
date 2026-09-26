import fs from "node:fs";
import path from "node:path";
import type { Router } from "@warlock.js/core";
import { resolveLocaleRouting } from "../server/locale-routing/resolve-locale-routing";
import { buildRobotsTxt } from "./build-robots-txt";
import { resolveRobotsConfig, resolveSitemapReferenceUrl } from "./resolve-robots-config";
import { resolveSitemapConfig } from "./resolve-sitemap-config";
import { joinOrigin } from "@warlock.js/sitemap";
import {
  createSitemapSiteSelector,
  isNonIndexableDynamicSite,
  selectSitemapSite,
  sitemapSiteBaseUrl,
} from "./site-sitemap";

export type RegisterRobotsRouteOptions = {
  /** The app's source `public/` directory — where a hand-written `robots.txt` would live. */
  publicDir: string;
  warn?: (message: string) => void;
  /**
   * Production build manifest's `publicFiles`. When given, it (not the source
   * `public/` directory, absent from `dist/`-only deployments) decides whether
   * the app ships its own `robots.txt`.
   */
  publicFiles?: readonly string[];
};

/**
 * Registers `GET /robots.txt`, unless the app ships its own file — an app's
 * own `public/robots.txt` wins outright and web registers no route at all
 * (contract Part 3), because a second responder for the same path would be
 * either a silent shadow or a 500 depending on registration order, and
 * neither is the failure the app should ever see.
 *
 * Also skipped when `web.robots.enabled` is `false`: an app that never opted
 * in gets no route, same as `web.sitemap`.
 */
export function registerRobotsRoute(router: Router, options: RegisterRobotsRouteOptions): void {
  const warn = options.warn ?? console.warn;
  const ownRobotsFile = path.join(options.publicDir, "robots.txt");

  const shipsOwnRobots = options.publicFiles
    ? options.publicFiles.includes("robots.txt")
    : fs.existsSync(ownRobotsFile);

  if (shipsOwnRobots) {
    warn(
      "[warlock:web] public/robots.txt exists — web will not register /robots.txt, and the " +
        "automatic `Sitemap:` line is not injected into it. Add it yourself if the sitemap is enabled.",
    );
    return;
  }

  const robotsConfig = resolveRobotsConfig();

  if (!robotsConfig.enabled) return;

  const sitemapUrl = resolveSitemapReferenceUrl();
  const siteSelector = createSitemapSiteSelector();
  // `resolveLocaleRouting()`, not `readLocaleRouting()`: this route can be
  // registered standalone (e.g. directly in tests), before either page-route
  // installer has run `publishLocaleRouting()`. Reading `web.localeRouting`
  // straight from config works regardless of installer order.
  const localeRouting = resolveLocaleRouting();

  router.get("/robots.txt", async ({ request, response }) => {
    const selected = await selectSitemapSite(request, siteSelector);
    if (selected?.kind === "not-found") return response.notFound();
    if (selected && isNonIndexableDynamicSite(selected)) {
      return response.text("User-agent: *\nDisallow: /\n");
    }

    const sitemapConfig = resolveSitemapConfig();
    const selectedSitemapUrl = selected
      ? sitemapConfig.enabled
        ? joinOrigin(sitemapSiteBaseUrl(request, selected), sitemapConfig.path)
        : undefined
      : sitemapUrl;
    return response.text(buildRobotsTxt(robotsConfig, selectedSitemapUrl, localeRouting));
  });
}
