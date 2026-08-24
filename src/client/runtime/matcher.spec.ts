import { describe, expect, expectTypeOf, it } from "vitest";
import { RouteRegistry } from "../../../../core/src/router/route-registry";
import type {
  RequestHandler,
  Route,
} from "../../../../core/src/router/types";
import { matchClientRoute } from "./index";
import type {
  ClientPageEntry,
  ClientRouteMatch,
  ClientRouteParams,
} from "./types";

const load = () => ({ Page: {}, layouts: [] });

function entry(name: string, path: string): ClientPageEntry {
  return { type: "page", name, path, load };
}

const pages = {
  home: entry("home", "/"),
  usersStatic: entry("users.me", "/users/me"),
  usersParam: entry("users.show", "/users/:id"),
  usersCatchAll: entry("users.catch", "/users/*"),
  docsCatchAll: entry("docs.catch", "/docs/*"),
  rootCatchAll: entry("root.catch", "/*"),
  exactRootCatchAll: entry("root.exact-catch", "*"),
  member: entry("member.show", "/teams/:teamId/members/:memberId"),
  encoded: entry("encoded.show", "/encoded/:value"),
  caseSensitiveSpelling: entry("case", "/Case/Path"),
  trailing: entry("trailing", "/trailing"),
} as const;

const shuffledOrders: readonly (readonly ClientPageEntry[])[] = [
  [
    pages.rootCatchAll,
    pages.usersCatchAll,
    pages.usersParam,
    pages.usersStatic,
    pages.home,
    pages.member,
    pages.docsCatchAll,
    pages.encoded,
    pages.caseSensitiveSpelling,
    pages.trailing,
  ],
  [
    pages.usersParam,
    pages.rootCatchAll,
    pages.usersStatic,
    pages.docsCatchAll,
    pages.trailing,
    pages.usersCatchAll,
    pages.member,
    pages.home,
    pages.caseSensitiveSpelling,
    pages.encoded,
  ],
  [
    pages.trailing,
    pages.caseSensitiveSpelling,
    pages.encoded,
    pages.home,
    pages.docsCatchAll,
    pages.member,
    pages.usersStatic,
    pages.usersParam,
    pages.usersCatchAll,
    pages.rootCatchAll,
  ],
];

type CorpusCase = {
  readonly pathname: string;
  readonly expectedEntry: ClientPageEntry;
  readonly params: ClientRouteParams;
};

const overlongParameter = "x".repeat(101);

const corpus: readonly CorpusCase[] = [
  { pathname: "/users/me", expectedEntry: pages.usersStatic, params: {} },
  { pathname: "/users/ALICE", expectedEntry: pages.usersParam, params: { id: "ALICE" } },
  { pathname: "/users/a/b", expectedEntry: pages.usersCatchAll, params: { "*": "a/b" } },
  { pathname: "/", expectedEntry: pages.home, params: {} },
  { pathname: "/outside/deep", expectedEntry: pages.rootCatchAll, params: { "*": "outside/deep" } },
  { pathname: "/docs/guide/start", expectedEntry: pages.docsCatchAll, params: { "*": "guide/start" } },
  {
    pathname: "/teams/red/members/blue",
    expectedEntry: pages.member,
    params: { teamId: "red", memberId: "blue" },
  },
  { pathname: "/encoded/%E2%9C%93%20ok", expectedEntry: pages.encoded, params: { value: "✓ ok" } },
  { pathname: "/encoded/a%2Fb", expectedEntry: pages.encoded, params: { value: "a/b" } },
  { pathname: "/encoded/%2520", expectedEntry: pages.encoded, params: { value: "%20" } },
  { pathname: "/docs/a%2Fb/c%20d", expectedEntry: pages.docsCatchAll, params: { "*": "a/b/c d" } },
  {
    pathname: `/users/${overlongParameter}`,
    expectedEntry: pages.usersCatchAll,
    params: { "*": overlongParameter },
  },
  { pathname: "/CASE/path", expectedEntry: pages.caseSensitiveSpelling, params: {} },
  { pathname: "/trailing/", expectedEntry: pages.trailing, params: {} },
];

const noop: RequestHandler = () => undefined as never;

function serverMatch(
  entries: readonly ClientPageEntry[],
  pathname: string,
): ClientRouteMatch | null {
  const registry = new RouteRegistry();
  const routes: Route[] = entries.map((page) => ({
    method: "GET",
    path: page.path,
    name: page.name,
    handler: noop,
    sourceFile: "",
    $prefix: "/",
    $prefixStack: [],
  }));
  registry.register(routes);
  const match = registry.find("GET", pathname);

  if (!match) return null;

  const matchedEntry = entries.find((page) => page.name === match.route.name);
  if (!matchedEntry) throw new Error("Server matcher returned an unknown fixture route");

  return { entry: matchedEntry, params: match.params };
}

function expectExactMatch(
  actual: ClientRouteMatch | null,
  expected: ClientRouteMatch | null,
): void {
  if (!expected) {
    expect(actual).toBeNull();
    return;
  }

  expect(actual?.entry).toBe(expected.entry);
  expect(actual?.params).toEqual(expected.params);
}

describe("matchClientRoute", () => {
  it("has an explicit typed absence result", () => {
    expectTypeOf(matchClientRoute).returns.toEqualTypeOf<ClientRouteMatch | null>();
  });

  it.each(shuffledOrders.map((entries, index) => ({ entries, index })))(
    "matches the literal corpus through server and client in shuffled order $index",
    ({ entries }) => {
      for (const fixture of corpus) {
        const literal = { entry: fixture.expectedEntry, params: fixture.params };
        const server = serverMatch(entries, fixture.pathname);
        const client = matchClientRoute(entries, fixture.pathname);

        expectExactMatch(server, literal);
        expectExactMatch(client, literal);
        expectExactMatch(client, server);
      }
    },
  );

  it("returns explicit absence for an unmatched URL", () => {
    const entries = [pages.usersParam, pages.usersStatic, pages.usersCatchAll];
    const literal = null;
    const server = serverMatch(entries, "/projects/42");
    const client = matchClientRoute(entries, "/projects/42");

    expectExactMatch(server, literal);
    expectExactMatch(client, literal);
    expectExactMatch(client, server);
  });

  it("uses the nested catch-all only when it consumes a value", () => {
    const entries = [pages.docsCatchAll, pages.rootCatchAll];
    const literal = { entry: pages.rootCatchAll, params: { "*": "docs" } };
    const server = serverMatch(entries, "/docs/");
    const client = matchClientRoute(entries, "/docs/");

    expectExactMatch(server, literal);
    expectExactMatch(client, literal);
    expectExactMatch(client, server);
  });

  it("gives the root catch-all an empty value at the root", () => {
    const entries = [pages.rootCatchAll];
    const literal = { entry: pages.rootCatchAll, params: { "*": "" } };
    const server = serverMatch(entries, "/");
    const client = matchClientRoute(entries, "/");

    expectExactMatch(server, literal);
    expectExactMatch(client, literal);
    expectExactMatch(client, server);
  });

  it("accepts and matches the exact root catch-all with server parameter parity", () => {
    const entries = [pages.exactRootCatchAll];

    for (const [pathname, params] of [
      ["/", { "*": "/" }],
      ["/alpha/beta", { "*": "/alpha/beta" }],
    ] as const) {
      const literal = { entry: pages.exactRootCatchAll, params };
      const server = serverMatch(entries, pathname);
      const client = matchClientRoute(entries, pathname);

      expectExactMatch(server, literal);
      expectExactMatch(client, literal);
      expectExactMatch(client, server);
    }
  });

  it("keeps the exact root catch-all distinct from the slash-prefixed catch-all", () => {
    for (const [page, rootValue, tailValue] of [
      [pages.exactRootCatchAll, "/", "/alpha/beta"],
      [pages.rootCatchAll, "", "alpha/beta"],
    ] as const) {
      for (const [pathname, value] of [["/", rootValue], ["/alpha/beta", tailValue]] as const) {
        const literal = { entry: page, params: { "*": value } };
        const server = serverMatch([page], pathname);
        const client = matchClientRoute([page], pathname);

        expectExactMatch(server, literal);
        expectExactMatch(client, literal);
        expectExactMatch(client, server);
      }
    }
  });

  it.each([
    [pages.exactRootCatchAll, pages.usersStatic],
    [pages.usersStatic, pages.exactRootCatchAll],
  ])("gives a static route precedence over the exact root catch-all", (...entries) => {
    const literal = { entry: pages.usersStatic, params: {} };
    const server = serverMatch(entries, "/users/me");
    const client = matchClientRoute(entries, "/users/me");

    expectExactMatch(server, literal);
    expectExactMatch(client, literal);
    expectExactMatch(client, server);
  });

  it("returns absence for malformed URL encoding before considering catch-alls", () => {
    const entries = [pages.encoded, pages.rootCatchAll];
    const literal = null;
    const server = serverMatch(entries, "/encoded/%ZZ");
    const client = matchClientRoute(entries, "/encoded/%ZZ");

    expectExactMatch(server, literal);
    expectExactMatch(client, literal);
    expectExactMatch(client, server);
  });

  it.each([
    "users",
    "/users/*/rest",
    "/users/prefix*",
    "/users/:",
    "/users/:id?",
    "/files/:name.:extension",
    "/orders/:id(^\\d+)",
  ])("rejects malformed or unsupported pattern %s", (path) => {
    expect(() => matchClientRoute([entry("invalid", path)], "/users/42")).toThrow();
  });

  it.each([
    [entry("first", "/users/:id"), entry("second", "/users/:slug")],
    [entry("first", "/Users"), entry("second", "/users")],
    [entry("first", "/users"), entry("second", "/users/")],
  ])("rejects routes that collide under server matching", (first, second) => {
    expect(() => matchClientRoute([first, second], "/users/42")).toThrow();
  });
});
