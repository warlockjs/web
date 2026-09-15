/**
 * The `web.streaming` config namespace (design doc
 * `releases/v5.12-streaming-design.md`, Stage 1 point 6 and Stage 2 rule 7).
 *
 * No `@warlock.js/web` config namespace existed before this card — this file
 * both declares its shape (via `ConfigRegistry` module augmentation, the same
 * mechanism core's generated app-level typings use, `core/src/config/types.ts`)
 * and reads it, so the shape and the reader can never drift onto two
 * different keys.
 */
import { config, type Request } from "@warlock.js/core";

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
};

declare module "@warlock.js/core" {
  interface ConfigRegistry {
    web: WebConfigurations;
  }
}

/** Stage 2 rule 7's stated default. */
export const DEFAULT_DEFER_TIMEOUT_MS = 10_000;

/** Read `web.streaming.deferTimeout`, falling back to the documented default. */
export function resolveDeferTimeoutMs(): number {
  const web = config.get("web", {});

  return web.streaming?.deferTimeout ?? DEFAULT_DEFER_TIMEOUT_MS;
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
