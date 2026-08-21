/**
 * The fixture app's `SharedContext` augmentation — the same move v5/app makes
 * at `src/web/types.ts:23-59`, against the relative specifier because these
 * fixtures import web's source directly (no built package to resolve
 * `@warlock.js/web` to; see implementation/2026-08-20-A3-shared-proxy.md §2).
 */
declare module "../../../src/index" {
  interface SharedContext {
    /** Required — written unconditionally by App's `base` middleware. */
    locale: string;
    /** Required — same writer. */
    appName: string;
    /** Optional — written only when the request carries `?user=`. */
    user?: { name: string };
  }
}

export {};
