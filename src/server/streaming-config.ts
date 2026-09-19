/**
 * The `web.streaming` config namespace: crawler detection overrides and the
 * deferred-value timeout, the two runtime knobs streaming SSR exposes to an
 * app.
 *
 * No `@warlock.js/web` config namespace existed before this card — this file
 * both declares its shape (via `ConfigRegistry` module augmentation, the same
 * mechanism core's generated app-level typings use, `core/src/config/types.ts`)
 * and reads it, so the shape and the reader can never drift onto two
 * different keys.
 */
import { config, type Request } from "@warlock.js/core";
import type { WebSitemapConfig } from "../sitemap/sitemap-config-types";
import type { RobotsConfig } from "../sitemap/robots-config-types";
import type { LocaleRoutingStrategy } from "../routing/locale-routing";
import type { WebErrorReportingConfigurations } from "./error-reporting-config";

/**
 * Customises crawler detection (`detect-crawler.ts`). `userAgents` REPLACES
 * the built-in list rather than extending it — an app that wants the
 * built-ins plus one more pattern spreads `DEFAULT_CRAWLER_USER_AGENTS`
 * itself. `detect`, when given, wins outright: `userAgents` is never
 * consulted alongside it.
 */
export type CrawlerDetectionOptions = {
  userAgents?: readonly RegExp[];
  detect?: (request: Request) => boolean;
};

export type WebStreamingConfigurations = {
  /**
   * Crawler detection for the fully-resolved-document mode
   * (`detect-crawler.ts`, Stage 1 point 6): `false` disables detection
   * entirely (every request streams); an options object customises it;
   * `undefined` (the default) uses the built-in user-agent list.
   */
  crawlers?: false | CrawlerDetectionOptions;
  /**
   * Milliseconds a single `defer()`-ed value may take to settle before the
   * server treats it as failed with `DeferTimeoutError` (Stage 2 rule 7).
   */
  deferTimeout?: number;
};

export type WebConfigurations = {
  streaming?: WebStreamingConfigurations;
  /**
   * Milliseconds the non-deferred loader chain of ONE page request (app →
   * layout → page loaders, plus the page's own `validation` export) may run
   * before the request fails with `PageLoaderTimeoutError` (504) — card
   * `904a04eb`, audit §5.1. Never bounds a `defer()`-ed value (see
   * `streaming.deferTimeout` above) or the render that follows the loader
   * chain. `0` disables the bound entirely. Default 15000.
   */
  loaderTimeout?: number;
  /**
   * Sitemap generation policy. There is deliberately no `sitemap.baseUrl`
   * key — the origin is `app.publicUrl`, the single application origin, so
   * generation refuses rather than derives one when it is unset. See
   * `../sitemap/sitemap-config-types.ts`.
   */
  sitemap?: WebSitemapConfig;
  /**
   * Crawler policy — entirely owned by `web` (contract Part 3). Reads the
   * `Sitemap:` line from `sitemap` above rather than a second `baseUrl`.
   * See `../sitemap/robots-config-types.ts`.
   */
  robots?: RobotsConfig;
  /**
   * Locale URL routing policy (card A, `releases/v5.17-locale-routing-design-note.md`).
   * Codes come from `app.localeCodes` and the default from `app.localeCode` —
   * there is no second locale list here. See `../server/locale-routing/resolve-locale-routing.ts`.
   */
  localeRouting?: { strategy?: LocaleRoutingStrategy };
  /**
   * Server-side error reporting (card 1db238ca, audit §1.1-1.2) — an
   * app-owned `report()` hook, in addition to the unconditional
   * `console.error` floor every server error path already writes. See
   * `./error-reporting-config.ts` and `./report-server-error.ts`.
   */
  errors?: WebErrorReportingConfigurations;
};

declare module "@warlock.js/core" {
  interface ConfigRegistry {
    web: WebConfigurations;
  }
}

/** Stage 2 rule 7's stated default. */
const DEFAULT_DEFER_TIMEOUT_MS = 10_000;

/** Read `web.streaming.deferTimeout`, falling back to the documented default. */
export function resolveDeferTimeoutMs(): number {
  const web = config.get("web", {});

  return web.streaming?.deferTimeout ?? DEFAULT_DEFER_TIMEOUT_MS;
}

/** Card `904a04eb`'s stated default. */
const DEFAULT_LOADER_TIMEOUT_MS = 15_000;

/** Raised at request time when `web.loaderTimeout` is misconfigured. */
export class LoaderTimeoutConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LoaderTimeoutConfigError";
  }
}

/**
 * Read `web.loaderTimeout`, falling back to the documented default, and
 * validate it — a non-negative integer, or `0` to disable the bound
 * entirely. Called once per request (`execute-page-request.ts`), same as
 * {@link resolveDeferTimeoutMs}, so a misconfigured value fails the request
 * loudly rather than silently picking a nonsensical bound.
 */
export function resolveLoaderTimeoutMs(): number {
  const web = config.get("web", {});
  const value = web.loaderTimeout ?? DEFAULT_LOADER_TIMEOUT_MS;

  if (!Number.isInteger(value) || value < 0) {
    throw new LoaderTimeoutConfigError(
      `web.loaderTimeout must be a non-negative integer (milliseconds); received ${JSON.stringify(value)}.`,
    );
  }

  return value;
}

/**
 * Read `web.streaming.crawlers` as-is — `false`, an options object, or
 * `undefined` (no override configured). `detect-crawler.ts` is the sole
 * reader; kept here, not there, so this file stays the one place the config
 * shape is read off `config.get`.
 */
export function resolveCrawlersConfig(): false | CrawlerDetectionOptions | undefined {
  const web = config.get("web", {});

  return web.streaming?.crawlers;
}
