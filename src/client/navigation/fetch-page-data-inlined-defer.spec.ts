// @vitest-environment jsdom
/**
 * RELEASE BLOCKER — a `serverCache` route's JSON (non-NDJSON) data
 * representation never streams (docs, "page-caching.mdx"): every deferred
 * key the loader returned as a promise arrives already resolved to its plain
 * value, but the page component still reads it with `use()`. `fetchPageData`
 * must wrap that value in an already-fulfilled thenable
 * (`reviveInlinedDeferredValues`, `fetch-page-data.ts`) before handing the
 * payload back, so `use()` reads it synchronously with no suspend and no
 * "Minified React error #438".
 *
 * Same `use()`-through-React harness `fetch-page-data-ndjson.spec.ts` uses,
 * so the two files prove the two wire shapes side by side: this one never
 * suspends (the fallback must never be visible), the NDJSON file always does.
 */
import { act, createElement, use, Suspense, Component, type ReactNode } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageData } from "./fetch-page-data";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function respondWith(
  body: unknown,
  init: { status?: number; contentType?: string; url?: string } = {},
): void {
  const headers = new Headers();
  headers.set("content-type", init.contentType ?? "application/json; charset=utf-8");

  const response = {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers,
    url: init.url ?? "",
    text: async () => stringify(body),
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPageData — inlined deferred values (serverCache JSON representation)", () => {
  it("wraps a resolved deferred key in a settled thenable — status 'fulfilled', value — that use() reads with no suspend", async () => {
    respondWith({
      appData: {},
      layoutData: {},
      // The server already awaited `related` and put its plain, resolved
      // value back on the wire (`render-page.ts`'s
      // `restoreInlineDeferredForDataWire`) — this is exactly the shape a
      // serverCache MISS or HIT sends, never a Promise.
      pageData: { title: "Post", related: { slug: "next-post" } },
      shared: {},
      name: "posts.show",
      locale: "en",
      translations: {},
      deferred: ["related"],
    });

    const result = await fetchPageData("/posts/current");
    if (result.type !== "payload") throw new Error("expected a payload result");

    const related = (result.payload.pageData as Record<string, unknown>).related as {
      status: string;
      value: unknown;
      then: unknown;
    };

    // React's own tracked-thenable shape (`use()` reads this synchronously) —
    // not a bare object and not an ordinary, untracked `Promise`.
    expect(related.status).toBe("fulfilled");
    expect(related.value).toEqual({ slug: "next-post" });
    expect(typeof related.then).toBe("function");

    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? createElement("div", null, "errored") : this.props.children;
      }
    }

    function Related() {
      const value = use(related as unknown as Promise<{ slug: string }>);
      return createElement("div", null, JSON.stringify(value));
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;

    // A SYNCHRONOUS `act()` on purpose — an untracked `Promise` would force
    // this render to suspend at least once even though it is already
    // resolved, which only an async `act()` could observe past. Reaching the
    // final text on the FIRST, sync render is the proof `use()` never
    // suspended at all.
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(
          Boundary,
          null,
          createElement(
            Suspense,
            { fallback: createElement("div", null, "loading") },
            createElement(Related),
          ),
        ),
      );
    });

    expect(container.textContent).toBe(JSON.stringify({ slug: "next-post" }));

    root.unmount();
    container.remove();
  });

  it("leaves a payload with no deferred keys completely untouched", async () => {
    const payload = {
      appData: {},
      layoutData: {},
      pageData: { title: "Post" },
      shared: {},
      name: "posts.show",
      locale: "en",
      translations: {},
    };

    respondWith(payload);

    const result = await fetchPageData("/posts/current");

    expect(result).toEqual({ type: "payload", payload, url: "/posts/current" });
  });
});
