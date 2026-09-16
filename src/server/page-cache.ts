/**
 * The server-only page-cache API — split out of the app-facing barrel
 * (`../index.ts`, canon Gate A blocker) because its import graph reaches
 * `@warlock.js/cache` (`./page-cache-driver.ts`'s `await import(...)`), a
 * server-only `@warlock.js/*` package. The app-facing barrel is imported by
 * client code (e.g. `root.tsx`), so it must stay reachable from the client
 * bundle without ever pulling `@warlock.js/cache` in behind it.
 *
 * Import from `"@warlock.js/web/server"`: server-only, keeps
 * `@warlock.js/cache` out of the client bundle.
 */
export { invalidatePageCache } from "./invalidate-page-cache";
