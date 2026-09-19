/**
 * The `web.sitemap` policy shape — `src/config/web.ts`, Part 3b/4 of the
 * v5.16 sitemap contract. There is no `src/config/sitemap.ts` and no
 * `sitemap.baseUrl`: the origin is `app.publicUrl` alone
 * ({@link "./resolve-sitemap-origin.ts"}).
 *
 * Kept in its own file (rather than inline in `../server/streaming-config.ts`)
 * because it is the type every other module in this directory imports; the
 * config-registry augmentation stays in `streaming-config.ts`, which is
 * where `web.*` is already declared and read.
 */
import type { ChangeFreq, SitemapOptions } from "@warlock.js/sitemap";

export type SitemapLocaleConfig = {
  /** Locale codes to expand. Defaults to the app's configured `app.localeCodes`. */
  readonly codes?: readonly string[];
  /**
   * The locale whose URLs are also emitted at `x-default`. Defaults to the
   * app's configured `app.localeCode`. Unset (and `app.localeCode` unset too)
   * emits no `x-default` alternate.
   */
  readonly defaultLocale?: string;
  /** One file per locale, listed in the index. Default `false`. */
  readonly splitByLocale?: boolean;
};

export type WebSitemapConfig = {
  /** Ships `false` by default: a fresh app has no `app.publicUrl` yet to build absolute URLs from. */
  readonly enabled: boolean;
  /** Served path for the index or the single file. Default `/sitemap.xml`. Read by the HTTP route (Part B). */
  readonly path?: string;
  /**
   * Where the generated file(s) are written. Default `storagePath("sitemap")`.
   *
   * Must be a directory the sitemap owns outright: publishing replaces the
   * whole directory at once, so never point it at `public/` or any folder
   * holding other files. `@warlock.js/sitemap` refuses to replace a non-empty
   * directory it did not create (`UnownedOutputDirectoryError`). The
   * `/sitemap.xml` and shard routes serve the files from here.
   */
  readonly outputDir?: string;
  /** Write `.xml.gz` beside each shard when the large-site path is taken. Default `false`. */
  readonly gzip?: boolean;
  readonly defaults?: Pick<SitemapOptions, "changefreq" | "priority">;
  readonly locales?: SitemapLocaleConfig;
  /**
   * Overrides how a page's `path` is turned into a given locale's URL.
   * Warlock has no built-in locale-prefixed routing — locale resolves at
   * request time from `?locale=` query, then cookie, then header — so the
   * package default is `path` with `?locale=<code>` appended (`&locale=<code>`
   * when `path` already carries a query string). Set this only if the
   * application implements its own prefix-based locale routing instead; when
   * present, it replaces the default for every locale, though a page's own
   * `localePaths` still takes precedence over both.
   */
  readonly localeUrl?: (path: string, localeCode: string) => string;
  readonly regenerate?: RegeneratePolicy;
};

/**
 * Kept deliberately small: the join-in-flight and last-good-on-failure
 * behaviours (contract Part 6, rules 4-5) are not configurable — they are
 * always on. The one real knob is whether `warlock build` / production boot
 * generate automatically at all.
 */
export type RegeneratePolicy = {
  /**
   * Generate at boot — dev and production. Default `true`. `warlock build`
   * never generates: it cannot read app config, and a built bundle carries no
   * page source files to read (`../build/contribution.ts`); production boot
   * reads the page manifest instead, once, before this connector's routes are
   * scanned.
   */
  readonly onBoot?: boolean;
};

export type { ChangeFreq };
