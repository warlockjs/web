import { afterEach, describe, expect, it, vi } from "vitest";
import { connectRequestSearch, queryStringOf } from "../../routing/query-string";
import { routerEvents } from "../../routing/router-events";
import { readQueryStringValue, type QueryStringCache } from "./use-query-string";

/**
 * `readQueryStringValue` — the snapshot `useQueryString` reads, extracted so
 * it is callable with no React renderer.
 *
 * ## Why this file does not mount `useQueryString` itself
 *
 * `web`'s suite runs under `environment: "node"` (`vitest.config.ts`) with no
 * DOM test dependency, and only collects `src/**\/*.spec.ts` — not `.tsx` —
 * so there is no way to mount a component and let React's commit phase run
 * `useSyncExternalStore`'s effect. `refresh.spec.ts` records the same
 * constraint for `refresh()` and solves it the same way: the logic is
 * extracted behind a plain function, proven here against the REAL
 * `routerEvents` singleton (`routing/router-events.ts`) — the same object
 * `navigation-root.tsx` emits on and `useQueryString`'s `subscribe` argument
 * literally is `routerEvents.onNavigated`. What is simulated is only the
 * React commit that would call `getSnapshot` again once `onStoreChange`
 * fires; the event, the emitter and the parser are all the production ones.
 */

function freshCache(): QueryStringCache {
  return { current: undefined };
}

afterEach(() => {
  connectRequestSearch(undefined);
  vi.unstubAllGlobals();
});

describe("missing key vs. present-but-empty", () => {
  it("answers undefined for an absent key, never an empty string", () => {
    vi.stubGlobal("window", { location: { search: "?a=1" } });

    expect(readQueryStringValue("missing", freshCache())).toBeUndefined();
  });

  it("answers the empty string for a key present with no value, distinct from absent", () => {
    vi.stubGlobal("window", { location: { search: "?a=" } });

    expect(readQueryStringValue("a", freshCache())).toBe("");
  });

  it("is undefined on the server too, for a key genuinely absent from the request", () => {
    connectRequestSearch(() => "?a=1");

    expect(typeof window).toBe("undefined");
    expect(readQueryStringValue("missing", freshCache())).toBeUndefined();
  });
});

describe("parity with queryStringOf — the server's writer", () => {
  it("decodes a scalar exactly as the encoder wrote it", () => {
    const written = queryStringOf({ status: "active" });
    vi.stubGlobal("window", { location: { search: written } });

    expect(readQueryStringValue("status", freshCache())).toBe("active");
  });

  it("decodes a `key[]` array written by queryStringOf as an array", () => {
    const written = queryStringOf({ tags: ["a", "b"] });
    vi.stubGlobal("window", { location: { search: written } });

    expect(readQueryStringValue("tags", freshCache())).toEqual(["a", "b"]);
  });

  it("decodes a `key[sub]` bag written by queryStringOf as a nested object", () => {
    const written = queryStringOf({ filter: { status: "active" } });
    vi.stubGlobal("window", { location: { search: written } });

    expect(readQueryStringValue("filter", freshCache())).toEqual({ status: "active" });
  });
});

describe("caching: the reference must stay stable while the search string does not", () => {
  it("returns the SAME array reference across two reads of an unchanged search", () => {
    vi.stubGlobal("window", { location: { search: queryStringOf({ tags: ["a", "b"] }) } });
    const cache = freshCache();

    const first = readQueryStringValue("tags", cache);
    const second = readQueryStringValue("tags", cache);

    expect(first).toBe(second);
  });

  it("recomputes once the search string actually changes", () => {
    const location = { search: queryStringOf({ tags: ["a"] }) };
    vi.stubGlobal("window", { location });
    const cache = freshCache();

    const first = readQueryStringValue("tags", cache);

    location.search = queryStringOf({ tags: ["a", "b"] });

    const second = readQueryStringValue("tags", cache);

    expect(first).toEqual(["a"]);
    expect(second).toEqual(["a", "b"]);
    expect(first).not.toBe(second);
  });
});

describe("SSR first render — RULED: the server reads the request URL, not undefined", () => {
  it("does not throw on the server and does not blank out a key present in the request", () => {
    connectRequestSearch(() => "?q=widgets");

    expect(typeof window).toBe("undefined");
    expect(() => readQueryStringValue("q", freshCache())).not.toThrow();
    expect(readQueryStringValue("q", freshCache())).toBe("widgets");
  });

  it("INNOCENT: the server render and the first client render agree for the same request", () => {
    connectRequestSearch(() => "?q=widgets&page=2");
    expect(typeof window).toBe("undefined");

    const serverValue = readQueryStringValue("page", freshCache());

    expect(serverValue).toBe("2");

    // Hydration: the browser's own location now carries the SAME request URL
    // the server rendered from — the case a mismatched answer would break.
    vi.stubGlobal("window", { location: { search: "?q=widgets&page=2" } });

    const clientValue = readQueryStringValue("page", freshCache());

    expect(clientValue).toBe(serverValue);
  });
});

describe("red control: a Link navigation that changes only the query string", () => {
  it("GUILTY: notifies a subscriber of onNavigated, which reads the new value", () => {
    vi.stubGlobal("window", { location: { search: "?q=old" } });
    const cache = freshCache();

    // The mount-time render.
    let displayed = readQueryStringValue("q", cache);

    expect(displayed).toBe("old");

    // `useQueryString`'s `subscribe` argument IS this call — the real emitter,
    // not a stand-in.
    const unsubscribe = routerEvents.onNavigated(() => {
      displayed = readQueryStringValue("q", cache);
    });

    try {
      // A `<Link>` navigation that changes ONLY the query string:
      // `navigation-root.tsx`'s `apply()` moves the URL with `pushState`
      // (simulated here by mutating the stubbed location) and then, now that
      // it is wired, announces completion the same way.
      vi.stubGlobal("window", { location: { search: "?q=new" } });
      routerEvents.emitNavigated({
        url: "/products?q=new",
        resolvedUrl: "/products?q=new",
        mode: "push",
      });

      expect(displayed).toBe("new");
    } finally {
      unsubscribe();
    }
  });

  it("THE DEFECT RETURNING: with the subscription removed, the rendered value stays stale after that same navigation", () => {
    vi.stubGlobal("window", { location: { search: "?q=old" } });
    const cache = freshCache();

    // The mount-time render — nothing subscribes afterwards, simulating
    // `useQueryString` with its `subscribe` argument deleted.
    const displayed = readQueryStringValue("q", cache);

    expect(displayed).toBe("old");

    // The SAME navigation as the guilty case: the URL moves and the
    // navigation completes.
    vi.stubGlobal("window", { location: { search: "?q=new" } });
    routerEvents.emitNavigated({
      url: "/products?q=new",
      resolvedUrl: "/products?q=new",
      mode: "push",
    });

    // Nothing told the component to look again, so what it is showing is
    // still the value from before the navigation — even though the true,
    // live answer has already moved on. This is the defect the subscription
    // exists to prevent.
    expect(displayed).toBe("old");
    expect(readQueryStringValue("q", freshCache())).toBe("new");
  });
});
