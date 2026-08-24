import type { PageRouteEntry } from "./execute-page-request.types";

/**
 * Stage 1 — turn a URL into a route entry plus its params.
 *
 * ⚠ **This is a SECOND matcher, and on the HTTP path it is redundant.** Core's
 * router has already matched by the time a page handler runs, and
 * `create-page-route-handler.ts` ignores the match it is handed. The one caller
 * that genuinely needs this is `renderPage(name, options)`, which synthesizes a
 * URL with no HTTP request behind it — and that path is not wired up
 * (`connectPageRoutes()` is never called).
 *
 * Removing it from the HTTP path is carded. Two things must be proven first:
 * that these params agree with core's, since `bundle.route.params` reaches the
 * hydration payload; and that dropping `bundle.route.query` — a public type
 * member — is announced rather than slipped in.
 */

function splitSegments(path: string): string[] {
  return path.split("/").filter(segment => segment.length > 0);
}

export function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | undefined {
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
