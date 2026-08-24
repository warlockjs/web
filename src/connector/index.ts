/**
 * The CONNECTOR-FACING entry point of `@warlock.js/web` — `"./connector"` in
 * `web/package.json` — the build→runtime handoff surface.
 *
 * WHY A SUBPATH AND NOT THE ROOT BARREL: the root barrel is the CLIENT-facing
 * surface — it exports `Link`, `Head`, `Scripts` and the shared-context hooks,
 * so its static graph reaches React. Everything here is named by two callers
 * that must stay React-free: `warlock.config.ts`, which merely CONSTRUCTS a
 * connector, and the generated `<productionDir>/pages.ts` barrel. Re-exporting
 * these through `"."` would make every config load statically pull React —
 * the reason that shape was rejected.
 *
 * KEEP THIS BARREL LIGHT. Its whole static graph today is `node:fs`,
 * `node:path` and one string constant (`HYDRATION_CLIENT_ENTRY_NAME`); every
 * heavy half is reached by `await import(...)` inside a hook. A value import
 * of `react`, `react-dom`, `vite` or `@warlock.js/core` added here breaks
 * constraint A for every consuming app's config file. Type-only imports are
 * fine — `verbatimModuleSyntax` erases them.
 *
 * The `webConnector` factory is exported from here too, so the connector
 * keeps ONE public specifier rather than growing a second barrel beside this
 * one.
 */

export { createWebBuildContribution, WebPackageRootResolutionError } from "../build/contribution";
export type { WebBuildOptions } from "../build/contribution";

export { consumePageManifest, providePageManifest } from "../server/page-manifest";
export type {
  PageManifest,
  PageManifestLayoutEntry,
  PageManifestPageEntry,
} from "../server/page-manifest";

export { CLIENT_ASSET_URL_PREFIX } from "../server/client-asset-url-prefix";

export {
  resolveHydrationClientUrl,
  WebClientAssetPrefixViolationError,
  WebClientManifestEntryMissingError,
  WebClientManifestMalformedError,
  WebClientManifestMissingError,
} from "../server/hydration-client-url";
export type { ResolveHydrationClientUrlOptions } from "../server/hydration-client-url";

export { webConnector } from "../server/web-connector-factory";
