import type { PageRouteEntry } from "./execute-page-request.types";

/**
 * Stage 1 — turn a URL into a route entry plus its params.
 *
 * This matches only URL-driven render requests that have no HTTP router result
 * to carry through. On the live HTTP path core has already selected the route
 * and decoded its params; `create-page-route-handler.ts` passes that match into
 * the pipeline rather than re-running this matcher.
 *
 * `match-page-route.parity.spec.ts` keeps the param contract gated, including
 * a multi-segment URL and the param-free page catch-all convention.
 */

function splitSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(pathname);

  if (patternSegments.length !== pathSegments.length) return undefined;

  const params: Record<string, string> = {};

  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];

    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }

    if (patternSegment !== pathSegment) return undefined;
  }

  return params;
}

export function matchRoute(
  pathname: string,
  routes: readonly PageRouteEntry[],
): { entry: PageRouteEntry; params: Record<string, string> } | undefined {
  for (const entry of routes) {
    const params = matchPath(entry.path, pathname);

    if (params) return { entry, params };
  }

  return undefined;
}
