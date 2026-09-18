/**
 * Reads `web.sitemap` and folds in every default this contract states —
 * `enabled` defaults to `false`, so a fresh app that has not opted in never
 * pays for discovery. Kept separate from `../server/streaming-config.ts` so
 * that file stays the one place the `web.*` config-registry shape is
 * declared, not where every namespace's defaults are folded in.
 */
import { config, getPublicUrl, storagePath } from "@warlock.js/core";
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
    };
  readonly regenerate: Required<RegeneratePolicy>;
};

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
  const codes = localesConfig?.codes ?? config.key<string[]>("app.locales", []) ?? [];

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
      defaultLocale: localesConfig?.defaultLocale,
      splitByLocale: localesConfig?.splitByLocale ?? false,
      localeUrl: sitemapConfig?.localeUrl,
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
