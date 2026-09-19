/**
 * Reads `web.sitemap` and folds in every default this contract states —
 * `enabled` defaults to `false`, so a fresh app that has not opted in never
 * pays for discovery. Kept separate from `../server/streaming-config.ts` so
 * that file stays the one place the `web.*` config-registry shape is
 * declared, not where every namespace's defaults are folded in.
 */
import { config, getPublicUrl, storagePath } from "@warlock.js/core";
import { isPrefixedLocale, readLocaleRouting, type LocaleRouting } from "../routing/locale-routing";
import { withLocalePrefix } from "../routing/locale-prefixed-paths";
import { MissingPublicUrlError } from "./errors";
import type {
  RegeneratePolicy,
  SitemapLocaleConfig,
  WebSitemapConfig,
} from "./sitemap-config-types";

// `config.get("web", {})` mirrors `../server/streaming-config.ts` deliberately:
// `web.*` is read as one group there too, so the two namespaces cannot drift
// onto two different access styles for the same config key.

export type ResolvedSitemapConfig = {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly path: string;
  readonly outputDir: string;
  readonly gzip: boolean;
  readonly defaults: WebSitemapConfig["defaults"];
  readonly locales: Required<Pick<SitemapLocaleConfig, "splitByLocale">> &
    Pick<SitemapLocaleConfig, "defaultLocale"> & {
      readonly codes: readonly string[];
      readonly localeUrl: WebSitemapConfig["localeUrl"];
      /** See `expand-locale-entries.ts`'s `LocaleMatrix.localeRoutingActive`. */
      readonly localeRoutingActive: boolean;
    };
  readonly regenerate: Required<RegeneratePolicy>;
};

/**
 * Design note §D.1: the strategy-aware `localeUrl` default an active
 * `web.localeRouting.strategy` gives the sitemap when the app did not
 * configure its own — the default locale bare under `"prefix-except-default"`,
 * prefixed under `"prefix"`, mirroring `isPrefixedLocale`/`withLocalePrefix`
 * (`../routing/locale-routing.ts`, `../routing/locale-prefixed-paths.ts`),
 * the SAME functions the server installers use to register these exact URLs.
 */
function routingAwareLocaleUrl(routing: LocaleRouting): (path: string, code: string) => string {
  return (path, code) => (isPrefixedLocale(routing, code) ? withLocalePrefix(path, code) : path);
}

/**
 * Resolves policy without requiring `app.publicUrl` — a disabled sitemap
 * must not refuse a boot that never asked for one. The caller (`generate-sitemap.ts`)
 * is the one place that turns a missing origin into {@link MissingPublicUrlError},
 * and only once generation is actually attempted.
 */
export function resolveSitemapConfig(): ResolvedSitemapConfig {
  const sitemapConfig = config.get("web", {}).sitemap;

  const enabled = sitemapConfig?.enabled ?? false;
  const localesConfig = sitemapConfig?.locales;
  // `app.localeCodes` is the real app config key — the scaffold and real apps
  // declare locales there, and `Request.cacheLocale()` reads the same key
  // (`core/src/http/request.ts`). `web.sitemap.locales.codes` still wins when
  // an app sets it explicitly.
  const codes = localesConfig?.codes ?? config.key<string[]>("app.localeCodes", []) ?? [];
  // Mirrors `resolveLocaleConfiguration()` (`core/src/config/locale-configuration.ts`):
  // `app.localeCode` is the ONE place the app's default locale is declared.
  const defaultLocale =
    localesConfig?.defaultLocale ?? config.key<string>("app.localeCode") ?? undefined;

  // Design note §D.1: "the codes/default are the same as the routing's" —
  // `readLocaleRouting()` reads the SAME `app.localeCodes`/`app.localeCode`
  // keys above, published once at install (`resolve-locale-routing.ts`), so
  // this never re-derives a second answer for the same question.
  const routing = readLocaleRouting();
  const localeRoutingActive = routing.strategy !== "none";

  return {
    enabled,
    baseUrl: getPublicUrl(),
    path: sitemapConfig?.path ?? "/sitemap.xml",
    // `SitemapIndex.saveTo(outputDir)` swaps this ENTIRE directory
    // (`@warlock.js/sitemap`'s `publishAtomically`). Defaulting it to
    // `publicPath()` would let a successful generation delete every
    // unrelated public asset, so the default is a dedicated storage
    // directory the app never puts anything else in. `register-sitemap-routes.ts`
    // serves artifacts by the in-memory path `generate-sitemap.ts` returns,
    // not by re-deriving `publicPath()`, so this does not change served URLs.
    // An app that explicitly configures `outputDir` back to its public dir is
    // still protected by the package-level `UnownedOutputDirectoryError` refusal.
    outputDir: sitemapConfig?.outputDir ?? storagePath("sitemap"),
    gzip: sitemapConfig?.gzip ?? false,
    defaults: sitemapConfig?.defaults,
    locales: {
      codes,
      defaultLocale,
      splitByLocale: localesConfig?.splitByLocale ?? false,
      // Design note §D.1: "an explicit web.sitemap.localeUrl ... still wins" —
      // the app's own hook is read first, the routing-aware default only
      // fills in when the app never set one AND a strategy is active.
      localeUrl:
        sitemapConfig?.localeUrl ??
        (localeRoutingActive ? routingAwareLocaleUrl(routing) : undefined),
      localeRoutingActive,
    },
    regenerate: {
      onBoot: sitemapConfig?.regenerate?.onBoot ?? true,
    },
  };
}

/** Refuses generation when enabled and no origin is configured — the one place this throws. */
export function requireSitemapOrigin(resolved: ResolvedSitemapConfig): string {
  if (!resolved.baseUrl) throw new MissingPublicUrlError();

  return resolved.baseUrl;
}
