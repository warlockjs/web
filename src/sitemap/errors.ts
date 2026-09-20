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

/**
 * Raised when a LAYOUT declares a `sitemap` the contract does not accept —
 * a URL supplier function, `true`, a non-object, or an options object carrying
 * a key the sitemap never reads.
 *
 * It throws rather than ignoring the declaration, and that is the whole point.
 * A developer who writes a supplier on a layout and sees no error concludes it
 * worked; the pages then quietly never appear. That silence is the defect
 * class this seat exists to close (canon `51c7857b`: a mechanical gate cannot
 * be satisfied by an opinion, and one that abstains has not passed).
 *
 * Contract: `contracts/layout-sitemap-and-robots-5.17.md` §3 and §7.
 */
export class SitemapLayoutDeclarationError extends Error {
  public constructor(
    public readonly sourceFile: string,
    public readonly detail: string,
  ) {
    super(`Cannot use the \`sitemap\` export of "${sourceFile}": ${detail}`);
    this.name = "SitemapLayoutDeclarationError";
  }
}
