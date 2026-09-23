import { router } from "@warlock.js/core";
import type { NamedApiRouteMetadata } from "../routing/named-api-routes";

/** Called through the Vite SSR server barrel, sharing Core's live router instance. */
export function resolveNamedApiRoutes(): NamedApiRouteMetadata | undefined {
  try {
    const result: Record<string, { path: string; method: string }> = Object.create(null);
    for (const route of router.getNamedApiRoutes())
      result[route.name] = Object.freeze({ path: route.path, method: route.method });
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}
