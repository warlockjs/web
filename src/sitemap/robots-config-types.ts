/**
 * The `web.robots` policy shape — `src/config/web.ts`, contract Part 3/4.
 *
 * Owned entirely by `web`: the sitemap package has no `robots.txt` concept at
 * all (contract Part 3). Kept beside {@link "./sitemap-config-types.ts"}
 * because the one thing the two share — the `Sitemap:` line — is resolved
 * from `web.sitemap`, never duplicated here as a second `baseUrl`-shaped key.
 */
export type RobotsGroup = {
  readonly userAgent: string | readonly string[];
  readonly allow?: readonly string[];
  readonly disallow?: readonly string[];
};

export type RobotsConfig = {
  /** Ships `false` by default, matching `web.sitemap`. */
  readonly enabled: boolean;
  /** Append the `Sitemap:` line pointing at the configured sitemap. Default `true`. */
  readonly referenceSitemap?: boolean;
  readonly groups?: readonly RobotsGroup[];
  /**
   * Raw extra lines appended verbatim after the groups and the `Sitemap:`
   * line — e.g. `Host:` or a `Crawl-delay:` a group's shape doesn't cover.
   * Written as-is, one per array entry; no validation, no escaping.
   */
  readonly extra?: readonly string[];
};
