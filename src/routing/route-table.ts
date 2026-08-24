/**
 * The name→URL primitive, and the one route table both sides read.
 *
 * `href(name, params, query)` is the DURABLE primitive; `<Link>` is sugar over
 * it. That ordering is deliberate and ratified: a function serves emails,
 * redirects, `Location` headers and non-React callers, none of which can render
 * a component — and it keeps client-side navigation, when it lands, a behaviour
 * change rather than an API change.
 *
 * ── Why a process-global table is correct HERE ───────────────────────────────
 * Module-level mutable state is normally a defect in a server that handles
 * concurrent requests, and this codebase has a real example of that defect to
 * point at: `@mongez/react-router`'s `RouterWrapper` keeps the RENDERED PAGE
 * CONTENT in a module-level binding, so request B overwrites the tree request A
 * is about to serialize. That is why it is not on the SSR path.
 *
 * A route table is the opposite kind of value. It is derived from the file
 * system at boot, identical for every request in the process, and never written
 * during a request — the same category as the compiled route table the server's
 * own router holds. Nothing here is per-request, so there is nothing for two
 * requests to race over.
 *
 * The rule that keeps it that way: `publishRouteTable` is called at INSTALL
 * time (server) or at hydration entry (browser), and never from a loader, a
 * middleware, or a component.
 */

import { queryStringOf, type QueryStringInput } from "./query-string";

/** The two fields `href` needs. Callers may pass richer entries; the rest is ignored. */
export type RouteTableEntry = {
  readonly name: string;
  readonly path: string;
};

/** What `href` accepts for a `:param` segment. Rendered with `String(value)`. */
export type RouteParameters = Readonly<Record<string, unknown>>;

/**
 * Query values; an `undefined` value is omitted rather than serialized.
 *
 * A value may be a scalar, an array of scalars, or an object one level deep —
 * the shapes `@warlock.js/core` parses back out of the URL. Anything deeper
 * throws `UnserializableQueryValueError`; the grammar and the measurements
 * behind it are documented in query-string.ts.
 */
export type RouteQuery = QueryStringInput;

const PARAMETER_PATTERN = /:([A-Za-z0-9_]+)|\*/g;

/**
 * ── WHY THIS LIVES ON `globalThis` AND NOT IN A MODULE BINDING ───────────────
 *
 * A plain `let` here does not work in development, and the failure is silent
 * enough to be worth spelling out.
 *
 * In dev the process runs TWO module graphs over the same files. Route
 * installation is loaded by tsx/Node (it is CLI bootstrap and imports core
 * directly), while page and layout modules are evaluated by Vite's SSR module
 * runner — which keeps its own registry and its own instance of every module it
 * transforms, `@warlock.js/web` included. So a module-level binding written by
 * the installer is not the binding `<Link>` reads during render: the installer
 * publishes into one instance and the component finds the other one empty.
 *
 * That was measured, not theorised. With a module-level `let`, every anchor on
 * a server-rendered page threw `RouteTableNotPublishedError` with an empty
 * known-names list while installation had demonstrably run.
 *
 * `Symbol.for` resolves through the per-ISOLATE symbol registry, which both
 * graphs share because they are the same isolate. So the table is one value no
 * matter which graph reaches it first, and the module keeps its module-shaped
 * API. `publishedBy` is carried for diagnosis only.
 */
const ROUTE_TABLE_SLOT = Symbol.for("warlock.web.routeTable");

type RouteTableSlot = {
  table: Map<string, string>;
  publishedBy: string;
};

type RouteTableHost = typeof globalThis & {
  [ROUTE_TABLE_SLOT]?: RouteTableSlot;
};

/**
 * `undefined` means "nobody has published yet", which is a DIFFERENT fault from
 * "the table is published and this name is not in it" — an empty Map would
 * conflate them and send the reader hunting a route that was never missing.
 */
function readSlot(): RouteTableSlot | undefined {
  return (globalThis as RouteTableHost)[ROUTE_TABLE_SLOT];
}

export class RouteTableNotPublishedError extends Error {
  public constructor(public readonly routeName: string) {
    super(
      `Warlock href(${JSON.stringify(routeName)}) was called before the route table was ` +
        "published, so no route name resolves yet. The table is published once at boot — by " +
        "the server when it installs page routes, and by the hydration entry before it mounts. " +
        "Seeing this means href() ran outside both: typically a module evaluating at import " +
        "time, or a unit test that renders a component without publishing a table first.",
    );
    this.name = "RouteTableNotPublishedError";
  }
}

export class UnknownRouteNameError extends Error {
  public constructor(
    public readonly routeName: string,
    public readonly knownRouteNames: readonly string[],
  ) {
    super(
      `Warlock href(${JSON.stringify(routeName)}) does not name a known route. ` +
        (knownRouteNames.length === 0
          ? "The route table is published but empty, so no page declared a `route` discovery could see."
          : `The table knows: ${knownRouteNames.map(name => JSON.stringify(name)).join(", ")}.`),
    );
    this.name = "UnknownRouteNameError";
  }
}

export class MissingRouteParameterError extends Error {
  public constructor(
    public readonly routeName: string,
    public readonly parameterName: string,
    public readonly routePath: string,
  ) {
    super(
      `Warlock href(${JSON.stringify(routeName)}) is missing the parameter ` +
        `${JSON.stringify(parameterName)}, required by the route path "${routePath}". ` +
        "It is not defaulted: a missing parameter would otherwise be interpolated as the " +
        "literal text `undefined`, producing a link that renders correctly and 404s for a " +
        "visitor.",
    );
    this.name = "MissingRouteParameterError";
  }
}

export class UnknownRouteParameterError extends Error {
  public constructor(
    public readonly routeName: string,
    public readonly parameterNames: readonly string[],
    public readonly routePath: string,
  ) {
    super(
      `Warlock href(${JSON.stringify(routeName)}) was given ` +
        `${parameterNames.map(name => JSON.stringify(name)).join(", ")}, which the route path ` +
        `"${routePath}" does not declare. Passing an undeclared parameter is a typo often ` +
        "enough that it is refused rather than dropped; values meant for the query string go " +
        "in the third argument.",
    );
    this.name = "UnknownRouteParameterError";
  }
}

export class DuplicateRouteNameError extends Error {
  public constructor(
    public readonly routeName: string,
    public readonly paths: readonly [string, string],
  ) {
    super(
      `Warlock route table: two routes both claim the name ${JSON.stringify(routeName)} — ` +
        `"${paths[0]}" and "${paths[1]}". A name resolves to exactly one URL, so one of the ` +
        "two would silently win and every link to it would be wrong half the time.",
    );
    this.name = "DuplicateRouteNameError";
  }
}

/**
 * Publish the table. WHOLESALE — the previous one is discarded, not merged
 * into.
 *
 * Merging looks harmless until a page is deleted and the dev server restarts:
 * the dead name would stay resolvable, and `<Link>` would go on rendering a URL
 * the server no longer routes. The table has to be able to shrink.
 */
export function publishRouteTable(
  entries: readonly RouteTableEntry[],
  publishedBy = "unnamed",
): void {
  const table = new Map<string, string>();

  for (const entry of entries) {
    const existing = table.get(entry.name);

    if (existing !== undefined) {
      throw new DuplicateRouteNameError(entry.name, [existing, entry.path]);
    }

    table.set(entry.name, entry.path);
  }

  (globalThis as RouteTableHost)[ROUTE_TABLE_SLOT] = { table, publishedBy };
}

/**
 * Drop the table, returning the module to its pre-boot state.
 *
 * Exists for tests: the table is process-global, so a suite that published one
 * would otherwise leak it into every later test in the same worker and pass in
 * file order while failing under `--shuffle`.
 */
export function resetRouteTable(): void {
  delete (globalThis as RouteTableHost)[ROUTE_TABLE_SLOT];
}

/** The published names, for diagnostics. Empty when nothing is published. */
export function knownRouteNames(): readonly string[] {
  const slot = readSlot();

  return slot === undefined ? [] : [...slot.table.keys()];
}

/** Who published the live table, for diagnosis. `undefined` when nothing has. */
export function routeTablePublisher(): string | undefined {
  return readSlot()?.publishedBy;
}

function parameterNamesOf(routePath: string): readonly string[] {
  const names: string[] = [];

  for (const match of routePath.matchAll(PARAMETER_PATTERN)) {
    names.push(match[1] ?? "*");
  }

  return names;
}

function interpolate(
  routeName: string,
  routePath: string,
  params: RouteParameters | undefined,
): string {
  const declared = parameterNamesOf(routePath);
  const supplied = Object.keys(params ?? {}).filter(key => params?.[key] !== undefined);
  const undeclared = supplied.filter(key => !declared.includes(key));

  if (undeclared.length > 0) {
    throw new UnknownRouteParameterError(routeName, undeclared, routePath);
  }

  return routePath.replace(PARAMETER_PATTERN, match => {
    const name = match === "*" ? "*" : match.slice(1);
    const value = params?.[name];

    if (value === undefined) {
      throw new MissingRouteParameterError(routeName, name, routePath);
    }

    return encodeURIComponent(String(value));
  });
}

/**
 * Resolve a route NAME to a URL.
 *
 * A name, never a path: a moved page changes its URL and keeps its name, so
 * every call site keeps working. That is the property the hardcoded table in
 * the previous `<Link>` could not offer, because it restated six URLs by hand
 * and silently refused every other page in the app.
 *
 * The query half is delegated to `queryStringOf`, which lives next to the
 * DECODER it has to agree with. It used to live here, and being module-private
 * meant the read half could not share it — the one-writer rule held only
 * because nobody had written the second writer yet.
 *
 * @throws {UnserializableQueryValueError} when a query value nests deeper than
 * the wire format core parses can carry.
 */
export function href(
  name: string,
  params?: RouteParameters,
  query?: RouteQuery,
): string {
  const slot = readSlot();

  if (slot === undefined) throw new RouteTableNotPublishedError(name);

  const routePath = slot.table.get(name);

  if (routePath === undefined) {
    throw new UnknownRouteNameError(name, [...slot.table.keys()]);
  }

  return `${interpolate(name, routePath, params)}${queryStringOf(query)}`;
}
