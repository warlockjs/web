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
  SitemapCoordination,
  SitemapDuration,
  SitemapLocaleConfig,
  SitemapStorageConfig,
  WebSitemapConfig,
} from "./sitemap-config-types";

export type ResolvedSitemapStorage = Required<Pick<SitemapStorageConfig, "directory">> & {
  readonly disk?: string;
};

// `config.get("web", {})` mirrors `../server/streaming-config.ts` deliberately:
// `web.*` is read as one group there too, so the two namespaces cannot drift
// onto two different access styles for the same config key.

export type ResolvedSitemapConfig = {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly path: string;
  /**
   * Existing generator output location. It remains populated for compatibility;
   * new storage-aware callers must use `storage` unless this legacy override exists.
   */
  readonly outputDir: string;
  /** Explicit legacy `web.sitemap.outputDir`, absent when the default is in use. */
  readonly legacyOutputDir?: string;
  readonly storage: ResolvedSitemapStorage;
  readonly coordination: SitemapCoordination;
  readonly regenerateEveryMs?: number;
  readonly manifestPollMs: number;
  readonly cacheControl: string;
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

const DEFAULT_STORAGE_DIRECTORY = "sitemap";
const DEFAULT_MANIFEST_POLL_MS = 30_000;
const DEFAULT_CACHE_CONTROL = "public, max-age=300";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function resolveDuration(
  key: string,
  value: SitemapDuration | undefined,
  fallback?: number,
): number | undefined {
  if (value === undefined) return fallback;

  const milliseconds =
    typeof value === "number"
      ? value
      : (() => {
          const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
          if (!match) return Number.NaN;

          const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
            match[2].toLowerCase() as "ms" | "s" | "m" | "h" | "d"
          ];

          return Number(match[1]) * factor;
        })();

  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `web.sitemap.${key} must be a positive finite duration no greater than ${MAX_TIMER_DELAY_MS} milliseconds.`,
    );
  }

  return milliseconds;
}

function resolveStorage(sitemapConfig: WebSitemapConfig | undefined): ResolvedSitemapStorage {
  const storage = sitemapConfig?.storage;

  if (storage && sitemapConfig?.outputDir !== undefined) {
    throw new TypeError(
      "web.sitemap.storage and web.sitemap.outputDir cannot be configured together.",
    );
  }

  if (!storage) {
    return { directory: DEFAULT_STORAGE_DIRECTORY };
  }

  const disk = storage.disk?.trim();
  const configuredDirectory = storage.directory;
  const directory = configuredDirectory?.trim() ?? DEFAULT_STORAGE_DIRECTORY;

  if (storage.disk !== undefined && !disk) {
    throw new TypeError("web.sitemap.storage.disk must be a non-empty configured storage name.");
  }

  if (configuredDirectory !== undefined && !directory) {
    throw new TypeError("web.sitemap.storage.directory must be a non-empty relative directory.");
  }

  if (
    directory.startsWith("/") ||
    directory.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(directory) ||
    directory.split(/[\\/]+/).some((part) => part === "." || part === "..")
  ) {
    throw new TypeError(
      "web.sitemap.storage.directory must be a non-empty relative directory without traversal.",
    );
  }

  return { ...(disk ? { disk } : {}), directory };
}

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
  const outputDir = sitemapConfig?.outputDir ?? storagePath(DEFAULT_STORAGE_DIRECTORY);
  const coordination = sitemapConfig?.coordination ?? "local";

  if (coordination !== "local" && coordination !== "shared") {
    throw new TypeError('web.sitemap.coordination must be either "local" or "shared".');
  }

  const manifestPollMs = sitemapConfig?.manifestPollMs ?? DEFAULT_MANIFEST_POLL_MS;

  if (
    !Number.isFinite(manifestPollMs) ||
    manifestPollMs <= 0 ||
    manifestPollMs > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      "web.sitemap.manifestPollMs must be a positive finite millisecond value no greater than 2147483647.",
    );
  }

  const cacheControl = sitemapConfig?.cacheControl ?? DEFAULT_CACHE_CONTROL;

  if (!cacheControl.trim()) {
    throw new TypeError("web.sitemap.cacheControl must be a non-empty HTTP Cache-Control value.");
  }

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
    outputDir,
    legacyOutputDir: sitemapConfig?.outputDir,
    storage: resolveStorage(sitemapConfig),
    coordination,
    regenerateEveryMs: resolveDuration("regenerateEvery", sitemapConfig?.regenerateEvery),
    manifestPollMs,
    cacheControl,
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
