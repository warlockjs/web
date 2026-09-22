import type { LayoutModuleShape } from "./page-module-shapes";

/** Resolves the closest static robots directive for legacy, non-composed layouts. */
export function resolveLayoutRobots(
  modules: readonly LayoutModuleShape[],
  _sourceFiles?: readonly string[],
): string | undefined {
  let robots: string | undefined;

  modules.forEach((module) => {
    const candidate = typeof module.metadata === "function" ? undefined : module.metadata?.robots;

    if (typeof candidate === "string") robots = candidate;
  });

  return robots;
}
