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
import { config } from "@warlock.js/core";
import type { CrawlerDetectionOptions, WebConfigurations } from "../configurations";

// Compatibility exports for existing server imports. The augmentation remains
// here because loading this reader is what makes the server configuration key
// available; importing the public type surface alone does not create global
// configuration identity.
export type {
  CrawlerDetectionOptions,
  WebConfigurations,
  WebStreamingConfigurations,
} from "../configurations";
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
