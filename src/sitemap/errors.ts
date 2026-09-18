/**
 * Raised by {@link "./generate-sitemap.ts"} when `web.sitemap.enabled` is
 * `true` and `app.publicUrl` (and its `PUBLIC_APP_URL` fallback) are both
 * unset.
 *
 * Thrown before any page is discovered or any byte written: an absolute URL
 * built from a guessed host is worse than a refusal, because nothing
 * downstream reports it (contract Part 3b).
 */
export class MissingPublicUrlError extends Error {
  public constructor() {
    super(
      "web.sitemap.enabled is true but no application origin is configured. " +
        "Set `app.publicUrl` in src/config/app.ts (or the PUBLIC_APP_URL " +
        "environment variable) before generating a sitemap.",
    );
    this.name = "MissingPublicUrlError";
  }
}
