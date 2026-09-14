/**
 * THE single rule both page installers apply to fold a page's whole layout
 * chain into the render pipeline's ONE layout slot — dev's
 * `install-page-routes.ts` (`composeLayoutLevel`, loading each module via
 * `vite.ssrLoadModule`) and production's `install-page-routes-from-manifest.ts`
 * (`composeLayoutLevel`, reading each module off the built manifest). Both
 * sites differ only in WHERE a layout's module namespace comes from — this
 * function is pure and source-agnostic, and takes the already-resolved
 * modules as plain data.
 *
 * Composes three things off the chain, outermost first:
 *
 * - the HOST layout's own namespace (`...modules[hostIndex]`) — the layout
 *   selected to render, or the nearest one when none does
 *   (`../routing/layout-level.ts`'s `resolveLayoutLevel`)
 * - MIDDLEWARE, flattened across every layout on the chain — outermost
 *   first, the order stage 3 runs the array in
 *   (`execute-page-request.ts:519-524`) and the order an outer
 *   `optionalAuth` needs in order to have resolved an identity before an
 *   inner `gate()` checks it
 * - the LOADER, folded through `foldLayoutLoaders` against the same
 *   `hostIndex` — only the host's own return value becomes the page's data;
 *   every other layout's loader runs for its side effects (or its
 *   short-circuit) alone
 */
import { foldLayoutLoaders } from "./fold-layout-loaders";
import type { LayoutModuleShape } from "./page-module-shapes";

export function composeLayoutModules(
  modules: readonly LayoutModuleShape[],
  hostIndex: number,
): LayoutModuleShape {
  const host = modules[hostIndex];

  return {
    ...host,
    middleware: modules.flatMap((layoutModule) => [...(layoutModule.middleware ?? [])]),
    loader: foldLayoutLoaders(
      modules.map((layoutModule) => layoutModule.loader),
      hostIndex,
    ),
  };
}
