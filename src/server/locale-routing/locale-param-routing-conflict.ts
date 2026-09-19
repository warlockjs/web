/**
 * The boot error for design note §C.4: using a `web.localeRouting` config
 * strategy TOGETHER with a `[locale]`-folder page is refused at install
 * time, because the page's own leading `:locale` param would be prefixed a
 * second time by `./locale-prefixed-paths.ts` — double-prefixing a URL
 * nobody asked for (`/ar/:locale/posts`).
 *
 * Raised from `./locale-page-registrations.ts`, the one seam both installers
 * already share for every locale-routing decision, so dev and production
 * cannot disagree about which combination is illegal.
 */

/** Raised at boot when a `[locale]`-routed page coexists with an active config strategy. */
export class LocaleParamRoutingConflictError extends Error {
  public constructor(
    public readonly pageFile: string,
    public readonly strategy: string,
  ) {
    super(
      `"${pageFile}" is locale-routed by its own leading \`:locale\` param (a \`[locale]\` folder ` +
        `or an explicit \`/:locale/...\` route), but \`web.localeRouting.strategy\` is "${strategy}". ` +
        "Combining the two would prefix this page's URL twice. Either remove the leading `:locale` " +
        'segment from this page, or set `web.localeRouting.strategy` to "none" and let this page ' +
        "carry the locale on its own.",
    );
    this.name = "LocaleParamRoutingConflictError";
  }
}
