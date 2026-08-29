import type { ClientPageEntry, ClientRouteMatch } from "./types";

type RouteToken =
  | { readonly type: "static"; readonly value: string }
  | { readonly type: "parameter"; readonly name: string }
  | { readonly type: "catch-all" };

type CompiledRoute = {
  readonly entry: ClientPageEntry;
  readonly tokens: readonly RouteToken[];
  readonly parameterNames: readonly string[];
  readonly expression: RegExp;
  readonly collisionKey: string;
};

type SanitizedPath = {
  readonly path: string;
  readonly shouldDecodeParameters: boolean;
};

const PARAMETER_NAME = /^[A-Za-z0-9_]+$/;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIAL, "\\$&");
}

function decodeReservedCharacter(high: string, low: string): string | null {
  const pair = `${high}${low}`.toUpperCase();
  const reserved: Readonly<Record<string, string>> = {
    "23": "#",
    "24": "$",
    "25": "%",
    "26": "&",
    "2B": "+",
    "2C": ",",
    "2F": "/",
    "3A": ":",
    "3B": ";",
    "3D": "=",
    "3F": "?",
    "40": "@",
  };

  return reserved[pair] ?? null;
}

function sanitizePathname(pathname: string): SanitizedPath | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new Error("Client route pathname must start with '/'");
  }

  let path = pathname;
  let shouldDecode = false;
  let shouldDecodeParameters = false;

  for (let index = 1; index < path.length; index++) {
    if (path[index] !== "%") continue;

    const high = path[index + 1] ?? "";
    const low = path[index + 2] ?? "";
    const reserved = decodeReservedCharacter(high, low);

    if (reserved === null) {
      shouldDecode = true;
      continue;
    }

    shouldDecodeParameters = true;
    if (reserved === "%") {
      path = `${path.slice(0, index + 1)}25${path.slice(index + 1)}`;
      shouldDecode = true;
      index += 2;
    }
    index += 2;
  }

  try {
    if (shouldDecode) path = decodeURI(path);
  } catch {
    return null;
  }

  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  return { path, shouldDecodeParameters };
}

function decodeParameter(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "%") {
      decoded += value[index];
      continue;
    }

    const reserved = decodeReservedCharacter(value[index + 1] ?? "", value[index + 2] ?? "");
    if (reserved === null) return value;

    decoded += reserved;
    index += 2;
  }

  return decoded;
}

function parsePattern(entry: ClientPageEntry): CompiledRoute {
  const original = entry.path;
  const isExactRootCatchAll = original === "*";
  if (!isExactRootCatchAll && !original.startsWith("/")) {
    throw new Error(`Client route pattern '${original}' must start with '/'`);
  }

  const pattern = original.length > 1 && original.endsWith("/")
    ? original.slice(0, -1)
    : original;
  const segments = isExactRootCatchAll
    ? ["*"]
    : pattern === "/"
      ? []
      : pattern.slice(1).split("/");
  const tokens: RouteToken[] = [];
  const parameterNames: string[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) {
      throw new Error(`Client route pattern '${original}' contains an empty segment`);
    }

    if (segment === "*") {
      if (index !== segments.length - 1) {
        throw new Error(`Client route pattern '${original}' has a non-terminal catch-all`);
      }
      tokens.push({ type: "catch-all" });
      parameterNames.push("*");
      continue;
    }

    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!PARAMETER_NAME.test(name)) {
        throw new Error(`Client route pattern '${original}' has an unsupported parameter segment`);
      }
      if (parameterNames.includes(name)) {
        throw new Error(`Client route pattern '${original}' repeats parameter '${name}'`);
      }
      tokens.push({ type: "parameter", name });
      parameterNames.push(name);
      continue;
    }

    if (segment.includes(":") || segment.includes("*") || segment.includes("?") || segment.includes("%")) {
      throw new Error(`Client route pattern '${original}' contains unsupported syntax`);
    }
    tokens.push({ type: "static", value: segment });
  }

  let source = "^";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "static") source += `/${escapeRegExp(token.value)}`;
    if (token.type === "parameter") source += "/([^/]{1,100})";
    if (token.type === "catch-all") {
      source += isExactRootCatchAll ? "(.*)" : index === 0 ? "/(.*)" : "/(.+)";
    }
  }
  if (tokens.length === 0) source += "/";
  source += "$";

  const collisionKey = tokens
    .map((token) => {
      if (token.type === "static") return `s:${token.value.toLowerCase()}`;
      if (token.type === "parameter") return "p";
      return "w";
    })
    .join("/");

  return {
    entry,
    tokens,
    parameterNames,
    expression: new RegExp(source, "i"),
    collisionKey,
  };
}

function compareSpecificity(left: CompiledRoute, right: CompiledRoute): number {
  const rank = (token: RouteToken | undefined): number => {
    if (!token || token.type === "static") return 3;
    if (token.type === "parameter") return 2;
    return 1;
  };

  const length = Math.max(left.tokens.length, right.tokens.length);
  for (let index = 0; index < length; index++) {
    const difference = rank(right.tokens[index]) - rank(left.tokens[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compileRoutes(entries: readonly ClientPageEntry[]): readonly CompiledRoute[] {
  const collisions = new Map<string, ClientPageEntry>();
  const routes = entries.map((entry) => {
    const route = parsePattern(entry);
    const existing = collisions.get(route.collisionKey);
    if (existing) {
      throw new Error(
        `Client route patterns '${existing.path}' and '${entry.path}' collide under server matching`,
      );
    }
    collisions.set(route.collisionKey, entry);
    return route;
  });

  return routes.sort(compareSpecificity);
}

/**
 * @deprecated Do not adopt for new code. This client-side matcher duplicates the
 * route grammar the server already evaluates, and divergence between the two is
 * silent (wrong page, not an error). It is superseded by navigation consuming the
 * server-returned page composition/page swap: the client requests loader data and
 * the matched page's identity rides back on that same response.
 *
 * Delete only after the server-answered page swap is proven working in production
 * use — not before. Deleting earlier leaves neither implementation in place.
 * Removing this export (and the `@warlock.js/web/client/runtime` re-export) is a
 * breaking change to a published subpath and must be announced as one.
 */
export function matchClientRoute(
  entries: readonly ClientPageEntry[],
  pathname: string,
): ClientRouteMatch | null {
  const routes = compileRoutes(entries);
  const sanitized = sanitizePathname(pathname);
  if (!sanitized) return null;

  for (const route of routes) {
    const match = route.expression.exec(sanitized.path);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let index = 0; index < route.parameterNames.length; index++) {
      const value = match[index + 1];
      params[route.parameterNames[index]] = sanitized.shouldDecodeParameters
        ? decodeParameter(value)
        : value;
    }
    return { entry: route.entry, params };
  }

  return null;
}
