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
import { config } from "@warlock.js/core";

export type WebStreamingConfigurations = {
  /**
   * User-agent matchers that make a request wait for `onAllReady` instead of
   * streaming from `onShellReady` (Stage 1 point 6) — out of scope for this
   * card as a FEATURE (no reader wires this into `create-page-route-handler.ts`
   * yet); declared here only so the namespace's shape is settled once.
   */
  crawlers?: readonly (string | RegExp)[];
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
