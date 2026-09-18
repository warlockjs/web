import type { DuplicateReport, RouteSummary } from "@warlock.js/sitemap";

/**
 * The bounded-mode result. `SitemapSetResult` (the large-site result) is
 * already defined by `@warlock.js/sitemap`; this is its bounded-mode
 * counterpart, named but never spelled out in the v5.16 contract text
 * (`generateSitemap(): Promise<SitemapSetResult | SitemapResult>`).
 *
 * `mode` is the announcement contract Part 4 asks for ("The switch is
 * announced once at generation time, never silently") — a caller can branch
 * on it, or on `SitemapSetResult`'s distinct shape (`indexPath`/`files`),
 * without probing which class ran.
 */
export type SitemapResult = {
  readonly mode: "single" | "disabled";
  readonly path?: string;
  readonly urls: number;
  readonly duplicates: readonly DuplicateReport[];
  readonly routes: readonly RouteSummary[];
};
