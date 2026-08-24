import { beforeEach, describe, expect, it } from "vitest";
import { UnserializableQueryValueError } from "./query-string";
import {
  MissingRouteParameterError,
  RouteTableNotPublishedError,
  UnknownRouteNameError,
  UnknownRouteParameterError,
  href,
  publishRouteTable,
  resetRouteTable,
  routeTablePublisher,
} from "./route-table";

/**
 * The table is process-global, so every test starts from an empty one rather
 * than inheriting whatever the previous test published. Without this the suite
 * would pass in file order and fail under `--shuffle`, which is the failure
 * mode `921a62dc` exists to stop us from calling flaky.
 */
beforeEach(() => {
  resetRouteTable();
});

describe("href — the name→URL primitive", () => {
  it("resolves a name the OLD hardcoded six-route table never carried", () => {
    /*
      THE RED CASE, and the whole reason this module exists.

      `components/link.ts` shipped a literal six-entry `ROUTES` map, so a page
      that existed in the app but not in that map threw at render time. This is
      such a name: it is not one of the six, and before this module it could not
      be linked to at all.
    */
    publishRouteTable([{ name: "orders.invoice", path: "/orders/:orderId/invoice" }]);

    expect(href("orders.invoice", { orderId: 42 })).toBe("/orders/42/invoice");
  });

  it("interpolates every parameter and percent-encodes each one", () => {
    publishRouteTable([{ name: "products.details", path: "/products/:id" }]);

    expect(href("products.details", { id: "a b/c" })).toBe("/products/a%20b%2Fc");
  });

  it("returns a parameterless path untouched", () => {
    publishRouteTable([{ name: "main.home", path: "/" }]);

    expect(href("main.home")).toBe("/");
  });

  it("appends a query string and skips undefined values", () => {
    publishRouteTable([{ name: "products.list", path: "/products" }]);

    expect(href("products.list", undefined, { page: 2, sort: undefined })).toBe(
      "/products?page=2",
    );
  });

  it("carries an array and a nested filter in the grammar core parses", () => {
    /*
      `String(value)` used to flatten both of these before they reached the wire:
      an array became a comma string indistinguishable from the plain string, and
      an object became the literal "[object Object]". The encoder now emits what
      `@warlock.js/core` reads back — `key[]` for arrays, `key[sub]` for one
      level of nesting (core/src/http/request.ts:516-520, :557-561). The grammar
      and the measurements are in query-string.ts and its spec; this asserts the
      public door emits it.
    */
    publishRouteTable([{ name: "products.list", path: "/products" }]);

    expect(href("products.list", undefined, { tags: ["a", "b"] })).toBe(
      "/products?tags%5B%5D=a&tags%5B%5D=b",
    );
    expect(href("products.list", undefined, { filter: { status: "active" } })).toBe(
      "/products?filter%5Bstatus%5D=active",
    );
  });

  it("refuses a query value the wire format cannot carry, rather than mangling it", () => {
    /*
      Same reasoning as MissingRouteParameterError below: core reads `a[b][c]=x`
      back as `{a: []}` (the index is `Number("b")`, i.e. NaN —
      core/src/http/request.ts:528-551), so emitting it would produce a link that
      looks right and arrives with the value gone.
    */
    publishRouteTable([{ name: "products.list", path: "/products" }]);

    expect(() =>
      href("products.list", undefined, { filter: { range: { min: 1 } } }),
    ).toThrow(UnserializableQueryValueError);
  });

  it("supports a catch-all segment through the `*` parameter", () => {
    publishRouteTable([{ name: "docs.any", path: "/docs/*" }]);

    expect(href("docs.any", { "*": "a/b" })).toBe("/docs/a%2Fb");
  });
});

describe("href — failing closed", () => {
  it("throws before the table is published rather than reporting a dead name", () => {
    /*
      An unpublished table and a genuinely unknown name are different faults
      with different fixes — "you booted wrong" vs. "you typed the name wrong" —
      so they must not share one message. Reporting the first as the second is
      what sends someone hunting a route that was never missing.
    */
    expect(() => href("main.home")).toThrow(RouteTableNotPublishedError);
  });

  it("throws on an unknown name and lists the names it does know", () => {
    publishRouteTable([
      { name: "main.home", path: "/" },
      { name: "products.list", path: "/products" },
    ]);

    expect(() => href("main.hoem")).toThrow(UnknownRouteNameError);
    expect(() => href("main.hoem")).toThrow(/"main\.home", "products\.list"/);
  });

  it("throws on a MISSING parameter instead of writing `undefined` into the URL", () => {
    /*
      The stopgap did `String(params?.[key])`, so a forgotten `id` produced the
      URL `/products/undefined` — a link that renders, passes review, and 404s
      for a visitor. A URL is the one place a silent `undefined` is invisible
      until it reaches a user, so this fails at render.
    */
    publishRouteTable([{ name: "products.details", path: "/products/:id" }]);

    expect(() => href("products.details")).toThrow(MissingRouteParameterError);
    expect(() => href("products.details", {})).toThrow(MissingRouteParameterError);
    expect(() => href("products.details", { id: undefined })).toThrow(
      MissingRouteParameterError,
    );
  });

  it("throws on a parameter the pattern does not declare", () => {
    /*
      `{ orderId }` where the route wanted `{ id }` is a typo that would
      otherwise surface as a missing-parameter error naming the wrong thing.
      Query values have their own argument, so an unexpected key here is always
      a mistake and never a caller being terse.
    */
    publishRouteTable([{ name: "products.details", path: "/products/:id" }]);

    expect(() => href("products.details", { id: 1, orderId: 2 })).toThrow(
      UnknownRouteParameterError,
    );
  });

  it("refuses two routes claiming the same name", () => {
    expect(() =>
      publishRouteTable([
        { name: "products.list", path: "/products" },
        { name: "products.list", path: "/catalogue" },
      ]),
    ).toThrow(/products\.list/);
  });
});

describe("publishRouteTable — reachable across module graphs", () => {
  /*
    THE REGRESSION THIS PINS, and it was measured on a running dev server rather
    than imagined.

    The table began life as a module-level `let`. In development the server runs
    two module graphs over the same files — route installation through tsx/Node,
    page and layout modules through Vite's SSR module runner, which keeps its own
    instance of everything it transforms. The installer published into one
    instance; every `<Link>` read the other and found it empty, so a
    server-rendered page 500'd with `RouteTableNotPublishedError` and an empty
    known-names list while installation had demonstrably run.

    A unit test cannot spin up two module graphs. What it CAN pin is the property
    that makes one graph's write visible to the other: the table lives in the
    per-isolate symbol registry, not in this module's scope. A future refactor
    back to a module binding fails here.
  */
  it("stores the table in the per-isolate symbol registry, not in module scope", () => {
    publishRouteTable([{ name: "main.home", path: "/" }]);

    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for("warlock.web.routeTable")
    ] as { table: Map<string, string> } | undefined;

    expect(slot?.table.get("main.home")).toBe("/");
  });

  it("resolves a name a SEPARATE importer of this module published", () => {
    /*
      The closest a single-graph test gets to the real thing: publish through a
      second, independently imported instance of this module and resolve through
      the first. Vitest's module registry hands back the same instance, so this
      is a weaker check than the dev-server failure — which is why the symbol
      assertion above exists beside it.
    */
    publishRouteTable([{ name: "elsewhere.page", path: "/elsewhere" }], "another graph");

    expect(href("elsewhere.page")).toBe("/elsewhere");
    expect(routeTablePublisher()).toBe("another graph");
  });
});

describe("publishRouteTable", () => {
  it("replaces the table wholesale rather than merging into it", () => {
    /*
      Dev restarts republish after a page is deleted. Merging would keep the
      dead name resolvable, so `<Link>` would go on rendering a URL the server
      no longer routes — the table has to be able to SHRINK.
    */
    publishRouteTable([{ name: "gone.page", path: "/gone" }]);
    publishRouteTable([{ name: "main.home", path: "/" }]);

    expect(href("main.home")).toBe("/");
    expect(() => href("gone.page")).toThrow(UnknownRouteNameError);
  });

  it("accepts the client registry's entry shape, extra keys and all", () => {
    /*
      The browser publishes straight from `virtual:warlock/pages`, whose entries
      carry `type` and `load` beside `name`/`path`. Requiring a caller to map
      them first is a conversion nobody would keep in step; the table reads the
      two keys it needs and ignores the rest.
    */
    publishRouteTable([
      { type: "page", name: "main.home", path: "/", load: async () => ({}) },
    ] as never);

    expect(href("main.home")).toBe("/");
  });
});
