/**
 * The registration point for the production {@link SitemapPageSource} —
 * one process-wide slot, set exactly once by `WebConnector.boot()`'s
 * production branch (`../server/web-connector.ts`), before
 * `registerWebHttpRoutes` runs the first generation.
 *
 * `collectSitemapEntries` falls back to this registry whenever a caller does
 * not pass its own `pageSource`, which is what lets the public
 * `regenerateSitemap()` keep working unchanged for an application that calls
 * it later (e.g. from `onPostPublished`) — the app never has to pass the
 * manifest itself.
 */
import type { SitemapPageSource } from "./sitemap-page-source";

let productionSource: SitemapPageSource | undefined;

export function setProductionSitemapPageSource(source: SitemapPageSource): void {
  productionSource = source;
}

export function getProductionSitemapPageSource(): SitemapPageSource | undefined {
  return productionSource;
}

/** Test-only: this module's state is a process-wide singleton by design. */
export function resetProductionSitemapPageSourceForTests(): void {
  productionSource = undefined;
}
