import { config } from "@warlock.js/core";

/**
 * Resolves the auth cookie name the server-side page cache's HIT bypass check
 * (`page-cache-eligibility.ts`'s `looksAuthenticated`) treats as a
 * credential — `auth.cookie.name`, default `"access_token"`.
 *
 * `web` cannot depend on `@warlock.js/auth` (it is not on `web`'s dependency
 * graph at all), but a request carrying that cookie must still be recognized
 * as "looks authenticated" before any loader runs. This reads the SAME
 * config key `@warlock.js/auth`'s own `authConfig.cookie.name()`
 * (`auth/src/services/auth-config.ts`) reads, by convention rather than by
 * import — the two packages agree on the key name, not on any shared code.
 *
 * Read fresh on every call, deliberately not memoized: config can change
 * between tests (and, in principle, between requests in a hot-reloadable
 * dev config), matching `auth-config.ts`'s own `config.key(...)` call, which
 * carries no memoization either.
 */
export function resolveAuthCookieName(): string {
  return config.key("auth.cookie.name", "access_token");
}
