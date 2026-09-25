/**
 * The server-only session API: page guards that answer 401/403/302 through
 * `@warlock.js/core`. Split out of the app-facing barrel (`./index.ts`) because
 * that barrel is imported by client code (`root.tsx`), and Gate A refuses any
 * client graph that reaches a server-only `@warlock.js/*` package.
 *
 * Import from `"@warlock.js/web/session"` in `*.setup.ts` files, loaders and
 * middleware. Client code reads the session with `useUser()` from
 * `"@warlock.js/web"`.
 */
export { requireGuest, requireUser } from "./session/require-user";
export type { RequireGuestOptions, RequireUserOptions } from "./session/require-user";
