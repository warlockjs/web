/** Browser-safe metadata for named API routes. No handlers or route options cross this boundary. */
export type NamedApiRouteMetadata = Readonly<
  Record<string, Readonly<{ path: string; method: string }>>
>;

let published: NamedApiRouteMetadata | undefined;

export function publishNamedApiRoutes(routes: NamedApiRouteMetadata | undefined): void {
  published = routes;
}

export function readNamedApiRoutes(): NamedApiRouteMetadata | undefined {
  return published;
}

/** Resolves one named API route for browser consumers. `all` has no safe request verb. */
export function resolveApiRoute(name: string): Readonly<{ path: string; method: string }> {
  const route = published && Object.hasOwn(published, name) ? published[name] : undefined;
  if (route === undefined) {
    throw new Error(
      `Named API route ${JSON.stringify(name)} is unavailable. Use an explicit path and method, or ensure the server registered that named API route before rendering.`,
    );
  }
  if (route.method === "all") {
    throw new Error(
      `Named API route ${JSON.stringify(name)} accepts method \"all\" and cannot choose a browser request verb. Use an explicit path and method.`,
    );
  }
  return route;
}

export function parseNamedApiRoutes(value: unknown): NamedApiRouteMetadata | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, { path: string; method: string }> = Object.create(null);
  for (const [name, route] of Object.entries(value)) {
    if (!route || typeof route !== "object" || Array.isArray(route)) return undefined;
    const { path, method } = route as Record<string, unknown>;
    if (typeof path !== "string" || typeof method !== "string") return undefined;
    result[name] = Object.freeze({ path, method });
  }
  return Object.freeze(result);
}
