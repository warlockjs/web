/**
 * The SINGLE authority for where built client assets are served.
 *
 * Two halves must agree and only one of them may own the literal:
 * `resolveHydrationClientUrl` GUARANTEES every URL it returns starts with this
 * prefix, and the production static-file route MUST mount `<clientDir>/assets`
 * at exactly this prefix by importing THIS symbol. A second `"/assets"`
 * literal anywhere else is a drift bug: the two copies can be edited apart,
 * and the failure mode is a silent 404 on the hydration script — the page
 * renders, never hydrates, and nothing throws.
 *
 * WHY THE `assets` SUBDIRECTORY AND NOT THE CLIENT ROOT: the client build dir
 * also contains `.vite/manifest.json`, the build→runtime handoff artifact,
 * which must NEVER be publicly served. Mounting the client root would expose
 * it. Mounting only the `assets` subdirectory keeps the manifest unreachable
 * while still serving every hashed artifact the manifest points at.
 */
export const CLIENT_ASSET_URL_PREFIX = "/assets";
