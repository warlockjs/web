import { type LocaleRouting, isPrefixedLocale } from "../routing/locale-routing";
import { withLocalePrefix } from "../routing/locale-prefixed-paths";
import type { RobotsConfig, RobotsGroup } from "./robots-config-types";

const NO_LOCALE_ROUTING: LocaleRouting = { strategy: "none", codes: [], defaultLocale: "" };

function userAgentLines(group: RobotsGroup): string[] {
  const agents = Array.isArray(group.userAgent) ? group.userAgent : [group.userAgent];

  return agents.map((agent) => `User-agent: ${agent}`);
}

/**
 * `true` when `path` is a plain, expandable rule path: rooted (`/...`),
 * not the bare root (`/` already covers every locale prefix), and free of
 * wildcard (`*`) or end-anchor (`$`) syntax, whose meaning under a locale
 * prefix this function has no business guessing.
 */
function isExpandableRulePath(path: string): boolean {
  return path.startsWith("/") && path !== "/" && !path.includes("*") && !path.includes("$");
}

/**
 * Under an active locale-routing strategy, every expandable rule path also
 * gets its prefixed variant for each prefixed locale code — so
 * `Disallow: /admin` also disallows `/ar/admin` — deduped and kept right
 * next to the original path, in `routing.codes` order.
 */
function expandLocalizedPaths(paths: readonly string[], routing: LocaleRouting): string[] {
  const result: string[] = [];

  for (const path of paths) {
    if (!result.includes(path)) result.push(path);

    if (!isExpandableRulePath(path)) continue;

    for (const code of routing.codes) {
      if (!isPrefixedLocale(routing, code)) continue;

      const prefixed = withLocalePrefix(path, code);

      if (!result.includes(prefixed)) result.push(prefixed);
    }
  }

  return result;
}

function groupLines(group: RobotsGroup, routing: LocaleRouting): string[] {
  const lines = [...userAgentLines(group)];

  for (const path of expandLocalizedPaths(group.allow ?? [], routing)) {
    lines.push(`Allow: ${path}`);
  }

  for (const path of expandLocalizedPaths(group.disallow ?? [], routing)) {
    lines.push(`Disallow: ${path}`);
  }

  return lines;
}

/**
 * Pure string builder — no filesystem, no config reads. `sitemapUrl` is
 * resolved by the caller ({@link "./resolve-robots-config.ts"}) from
 * `web.sitemap`, never read from here: this function has no opinion on
 * whether the sitemap is enabled, only on whether the URL it was handed
 * should be appended. `routing` is likewise resolved by the caller — via
 * `resolveLocaleRouting()`, not `readLocaleRouting()`, because this can run
 * before an installer has published anything (see
 * `./register-robots-route.ts`) — and defaults to strategy `"none"`, which
 * expands nothing, so existing callers are unaffected.
 */
export function buildRobotsTxt(
  config: RobotsConfig,
  sitemapUrl: string | undefined,
  routing: LocaleRouting = NO_LOCALE_ROUTING,
): string {
  const lines: string[] = [];

  for (const group of config.groups ?? []) {
    lines.push(...groupLines(group, routing));
  }

  for (const extra of config.extra ?? []) lines.push(extra);

  if (sitemapUrl && config.referenceSitemap !== false) {
    lines.push(`Sitemap: ${sitemapUrl}`);
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
