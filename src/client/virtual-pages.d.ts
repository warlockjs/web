/**
 * Ambient declaration for the CLIENT PAGE REGISTRY virtual module.
 *
 * The plugin that serves this id — `web/src/vite/page-registry-plugin.ts`,
 * whose `CLIENT_PAGE_REGISTRY_ID` is the authority on its spelling — has since
 * landed. The declaration is what lets `index.ts` compile against a module
 * the bundler, not the filesystem, provides.
 *
 * No top-level `import` statements: an ambient `declare module` in a file that
 * is itself a module becomes an AUGMENTATION, which would require the virtual
 * id to already resolve. Inline `import(...)` types keep this file a global
 * script, so the declaration stays ambient.
 *
 * The module id below and the `pages` export name are checked against their
 * source-of-truth constants in `virtual-pages.contract.ts`, a `.ts` file, not
 * here — both `tsconfig.json` and `tsconfig.typecheck.json` set
 * `skipLibCheck: true`, which skips type-checking `.d.ts` bodies, so an
 * assertion placed in this file would never actually run.
 */

declare module "virtual:warlock/pages" {
  /**
   * The page graph compiled into the client bundle, in discovery order. Every
   * `load` is a dynamic `import()`, so no page's code is fetched until that
   * page is the one being hydrated or navigated to.
   */
  export const pages: readonly import("./runtime/types").ClientPageEntry[];
}
