import type { ComponentType } from "react";
import type { SerializedErrorPageProps } from "../../hydration-payload";
import { loadClientRouteComposition, type ClientPageEntry } from "../runtime";

/**
 * The CURRENT route's app-owned error page, resolved the same way
 * `build-hydrated-tree.ts` resolves one for a server-selected error render —
 * `loadClientRouteComposition` against the same page registry — so
 * `DefaultErrorBoundary`'s floor prefers the identical component an app
 * author put at `error.page.tsx` for this route. `undefined` for an unknown
 * route name or a route with no error page. A composition that fails to load
 * rejects; `NavigationRoot` treats that the same as "no error page", since
 * the floor already has a safe built-in fallback for it.
 */
export async function resolveErrorPageComponent(
  pages: readonly ClientPageEntry[],
  name: string,
): Promise<ComponentType<SerializedErrorPageProps> | undefined> {
  const entry = pages.find((candidate) => candidate.name === name);

  if (entry === undefined) return undefined;

  const composition = await loadClientRouteComposition(entry);
  const component = composition.ErrorPage?.default;

  return typeof component === "function"
    ? (component as ComponentType<SerializedErrorPageProps>)
    : undefined;
}
