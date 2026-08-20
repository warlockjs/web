/**
 * @warlock.js/web — the SSR page pipeline contracts.
 *
 * M1 SKELETON: declarations only. Every runtime export throws
 * "@warlock.js/web is not implemented yet"; the types are the deliverable,
 * proven by type-checking the signed reference app (v5/app) against them.
 *
 * This barrel is the COMPLETE public surface — fourteen exports, matching the
 * README §"FRAMEWORK-owned" list of v5/app verbatim. Nothing else is public.
 */

/**
 * THE AUDIT SURFACE — everything the browser receives, declared by the app.
 *
 * Ships EMPTY and with NO index signature: `shared.anything` does not compile
 * until the application augments this interface (v5/app does at
 * `src/web/types.ts:23-59`). Required keys demand an unconditional middleware
 * writer; optional keys may be written conditionally.
 *
 * Declared HERE, in the entry module, and that placement is load-bearing:
 * applications augment the module `"@warlock.js/web"`, and TypeScript merges a
 * module augmentation only with interfaces declared in the module that
 * specifier resolves to — an interface re-exported through the barrel from a
 * concern file would NOT merge (microsoft/TypeScript#18877). The published
 * package's entry .d.ts must keep declaring it directly for the same reason.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SharedContext {}

export type { PageContext } from "./context";
export type { PageLoader, LayoutLoader, AppLoader } from "./loaders";
export type { PageProps, LayoutProps, AppProps } from "./props";
export type { PageMetadata } from "./metadata";
export { shared, useShared } from "./shared";
export { Link } from "./components/link";
export { Head } from "./components/head";
export { Scripts } from "./components/scripts";
