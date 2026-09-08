/**
 * Folds a page's whole layout chain's loaders into the render pipeline's ONE
 * layout-slot loader — shared by both page installers
 * (`install-page-routes.ts`'s dev `composeLayoutLevel`,
 * `install-page-routes-from-manifest.ts`'s production one). Source-agnostic:
 * this module never asks where a loader came from, only runs the ordered list
 * each caller already resolved from its own loaded layout modules.
 *
 * Runs outermost first — the order stage 3 runs the composed loader in
 * (`execute-page-request.ts:519-524`) and the order an outer `optionalAuth`
 * needs in order to have resolved an identity before an inner `gate()` checks
 * it — and stops the instant any loader short-circuits (a `Response` or a
 * `LoaderShortCircuitSignal`), so an outer redirect or guard never lets an
 * inner loader run at all. Only the HOST layout's own return value becomes
 * the page's data; every other layout's loader runs for its side effects
 * (or its short-circuit) alone.
 */
import { Response } from "@warlock.js/core";
import type { PipelineLoader } from "./execute-page-request";
import { isLoaderShortCircuit } from "./settle-page-response";

export function foldLayoutLoaders(
  loaders: readonly (PipelineLoader | undefined)[],
  hostIndex: number,
): PipelineLoader {
  return async (context) => {
    let hostData: unknown;

    for (let index = 0; index < loaders.length; index++) {
      const value = await loaders[index]?.(context);

      if (value instanceof Response || isLoaderShortCircuit(value)) return value;
      if (index === hostIndex) hostData = value;
    }

    return hostData;
  };
}
