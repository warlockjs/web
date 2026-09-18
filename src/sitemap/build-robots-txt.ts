import type { RobotsConfig, RobotsGroup } from "./robots-config-types";

function userAgentLines(group: RobotsGroup): string[] {
  const agents = Array.isArray(group.userAgent) ? group.userAgent : [group.userAgent];

  return agents.map((agent) => `User-agent: ${agent}`);
}

function groupLines(group: RobotsGroup): string[] {
  const lines = [...userAgentLines(group)];

  for (const path of group.allow ?? []) lines.push(`Allow: ${path}`);
  for (const path of group.disallow ?? []) lines.push(`Disallow: ${path}`);

  return lines;
}

/**
 * Pure string builder — no filesystem, no config reads. `sitemapUrl` is
 * resolved by the caller ({@link "./resolve-robots-config.ts"}) from
 * `web.sitemap`, never read from here: this function has no opinion on
 * whether the sitemap is enabled, only on whether the URL it was handed
 * should be appended.
 */
export function buildRobotsTxt(config: RobotsConfig, sitemapUrl: string | undefined): string {
  const lines: string[] = [];

  for (const group of config.groups ?? []) {
    lines.push(...groupLines(group));
  }

  for (const extra of config.extra ?? []) lines.push(extra);

  if (sitemapUrl && config.referenceSitemap !== false) {
    lines.push(`Sitemap: ${sitemapUrl}`);
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
