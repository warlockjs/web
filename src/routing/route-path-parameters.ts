/** One route parameter whose name can be represented precisely in generated TypeScript. */
export type RoutePathParameter = {
  name: string;
  optional: boolean;
};

/**
 * The parser either recognizes the whole route parameter grammar or deliberately
 * returns `broad`, so generated declarations never promise a narrower shape
 * than the router can accept.
 */
export type RoutePathParameterParse =
  { type: "precise"; parameters: readonly RoutePathParameter[] } | { type: "broad" };

const PARAMETER_SEGMENT = /^:([A-Za-z0-9_]+)(\?)?$/;

/**
 * Parse whole-segment `:name`, optional `:name?`, and terminal/bare `*`
 * parameters. Regex params, suffix params, repeated conflicting names, and any
 * later router syntax return `broad` rather than a misleading generated type.
 */
export function parseRoutePathParameters(path: string): RoutePathParameterParse {
  const parameters = new Map<string, boolean>();

  const segments = path.split("/");

  for (const [index, segment] of segments.entries()) {
    if (segment === "") continue;
    if (segment === "*") {
      if (index !== segments.length - 1 || parameters.has("*")) return { type: "broad" };
      parameters.set("*", false);
      continue;
    }

    const match = segment.match(PARAMETER_SEGMENT);
    if (match) {
      const name = match[1];
      const optional = match[2] === "?";
      if (name === undefined) return { type: "broad" };
      const existing = parameters.get(name);
      if (existing !== undefined && existing !== optional) return { type: "broad" };
      parameters.set(name, optional);
      continue;
    }

    if (segment.includes(":") || segment.includes("*")) return { type: "broad" };
  }

  return {
    type: "precise",
    parameters: [...parameters].map(([name, optional]) => ({ name, optional })),
  };
}
