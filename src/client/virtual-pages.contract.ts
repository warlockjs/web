/**
 * Compile-time contract for the `virtual:warlock/pages` module.
 *
 * This lives in a `.ts` file, not `virtual-pages.d.ts`, because both
 * `tsconfig.json` and `tsconfig.typecheck.json` set `skipLibCheck: true`,
 * which skips type-checking `.d.ts` BODIES. Assertions placed inside a
 * `.d.ts` are never evaluated by `tsc` under that setting — they read as
 * guards but catch nothing. A `.ts` file has no such exemption, so the
 * same assertions here are actually checked on every typecheck run.
 *
 * No runtime behavior: this file is type-only and compiles away entirely.
 */
export {};

// The id `declare module "virtual:warlock/pages"` uses in virtual-pages.d.ts
// must match the plugin's own `CLIENT_PAGE_REGISTRY_ID`. `declare module`
// takes a string literal and cannot reference a constant, so the literal is
// duplicated there; this assertion is what catches that duplicate drifting.
type WarlockClientPageRegistryId =
  typeof import("../vite/page-registry-plugin").CLIENT_PAGE_REGISTRY_ID;

type WarlockAssertRegistryId<Id extends WarlockClientPageRegistryId> = Id;

type _WarlockVirtualPagesIdCheck = WarlockAssertRegistryId<"virtual:warlock/pages">;

// The exported member name `pages` in virtual-pages.d.ts must match the
// generator's own `CLIENT_REGISTRY_EXPORT_NAME`, since `generateClientRegistry`
// emits `export const ${CLIENT_REGISTRY_EXPORT_NAME}`.
type WarlockClientRegistryExportName =
  typeof import("../build/generate-client-registry").CLIENT_REGISTRY_EXPORT_NAME;

type WarlockAssertRegistryExportName<Name extends WarlockClientRegistryExportName> = Name;

type _WarlockVirtualPagesExportNameCheck = WarlockAssertRegistryExportName<"pages">;
