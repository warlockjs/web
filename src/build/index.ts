/**
 * `@warlock.js/web/build` — the build-time page-graph surface.
 *
 * Its own subpath, NOT the root barrel. Everything reachable from here walks
 * the filesystem (`discoverPages`) and imports page files by path, so placing
 * it on the root barrel puts that module in the import graph of every page
 * that writes `import … from "@warlock.js/web"`. A generated app did exactly
 * that and answered 500 on every route in dev, because Vite's SSR runner
 * cannot load it. The boundary is decided by the IMPORT GRAPH, not by intent
 * (canon `10f6041c`, `c604f0bc`).
 *
 * Consumers reach this deliberately and lazily — `@warlock.js/sitemap`'s
 * connector imports it inside its request handler, never at module scope.
 */
export { listRoutablePages, type ListedRoutablePage } from "./list-routable-pages";
