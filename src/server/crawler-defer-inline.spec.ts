/**
 * Card e4db45bb — crawler/inline mode keeps deferred keys promise-shaped for
 * `use()`.
 *
 * Before this fix, `render-page.ts`'s `awaitAndInlineDeferred` branch (the
 * one BOTH a detected crawler's document request and a data request's
 * `awaitDeferredForDataRequest` fallback share) replaced a deferred
 * `pageData` key with its RAW resolved value. A component reading it through
 * `use(data.x)` inside `<Suspense>` — the stream-deferred-data skill's own
 * contract — then threw "An unsupported type was passed to use()" during
 * SSR, and the same raw value in the hydration payload made a JS-executing
 * crawler's hydration fail identically.
 *
 * Red-first: reverting `render-page.ts`'s `createSettledThenable` call back
 * to `pageDataRecord[key] = value` reproduces every failure below (see the
 * red-control note on each spec).
 */
import { createElement, Suspense, use } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Response } from "@warlock.js/core";
import { createCoreHttp, requestContext } from "./__fixtures__/core-http";
import * as App from "../../__tests__/server/fixtures/root";
import * as layout from "../../__tests__/server/fixtures/layout";
import { defer } from "../loaders/defer";
import { createSettledThenable } from "../loaders/settled-thenable";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "./index";
import { buildHydrationPayload } from "./build-hydration-payload";
import { connectSharedStore, type SharedStoreResolver } from "../shared";
import { prepareDeferredPageData } from "../client/runtime/defer-registry";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pageEntry(path: string, page: Record<string, unknown>): PageRouteEntry {
  return {
    path,
    name: path.replace("/", ""),
    triple: {
      app: App as unknown as PageTripleModule,
      layout: layout as unknown as PageTripleModule,
      page: page as unknown as PageTripleModule,
    },
  };
}

function Reviews({ reviews }: { reviews: Promise<{ rating: number }> }) {
  const value = use(reviews);
  return createElement("span", null, `rating:${value.rating}`);
}

function deferredPage(reviews: Promise<{ rating: number }>) {
  return {
    loader: async () => defer({ greeting: "hi", reviews }),
    default: ({ data }: { data: { greeting: string; reviews: Promise<{ rating: number }> } }) =>
      createElement(
        "main",
        null,
        data.greeting,
        createElement(
          Suspense,
          { fallback: "LOADING" },
          createElement(Reviews, { reviews: data.reviews }),
        ),
      ),
  };
}

describe("createSettledThenable — the SSR half of the fix", () => {
  it("use() reads the value synchronously, with no suspension, in a real React render", () => {
    const thenable = createSettledThenable({ rating: 5 });

    function Reader() {
      const value = use(thenable);
      return createElement("span", null, `rating:${value.rating}`);
    }

    // A bare `Promise.resolve({...})` handed to `use()` here would throw
    // (`renderToStaticMarkup` never awaits Suspense) — this is the exact
    // defect, reproduced at the smallest possible scale. Red control: replace
    // `createSettledThenable(value)` with `Promise.resolve(value)` and this
    // throws "A component suspended while responding to synchronous input."
    expect(renderToStaticMarkup(createElement(Reader))).toBe("<span>rating:5</span>");
  });
});

describe("renderPageRequest — crawler:true document render (item a)", () => {
  it("use(data.reviews) reads the inlined value with no render error and no fallback", async () => {
    const reviews = Promise.resolve({ rating: 5 });
    const entry = pageEntry("/dashboard", deferredPage(reviews));
    const http = createCoreHttp({ url: "/dashboard" });

    const rendered = await renderPageRequest("/dashboard", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      crawler: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    // Red control: reverting `render-page.ts`'s inline branch to assign the
    // raw settled value (`pageDataRecord[key] = settled[index].value`)
    // instead of `createSettledThenable(...)` makes this render throw before
    // `renderPageRequest` ever resolves — this spec goes red immediately.
    expect(rendered.status).toBe(200);
    expect(rendered.bundle?.error).toBeUndefined();
  });
});

describe("renderPageRequest — awaitDeferredForDataRequest (item c: the data path yields the same shape)", () => {
  it("use(data.reviews) reads the inlined value with no render error, and the returned data stays plain", async () => {
    const reviews = Promise.resolve({ rating: 5 });
    const entry = pageEntry("/dashboard", deferredPage(reviews));
    const http = createCoreHttp({ url: "/dashboard" });

    const rendered = await renderPageRequest("/dashboard", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      dataRequest: true,
      awaitDeferredForDataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    // Same fix, same failure mode, reached through the OTHER trigger the
    // shared `awaitAndInlineDeferred` branch has — red under the same
    // control as the crawler spec above.
    expect(rendered.status).toBe(200);
    expect(rendered.bundle?.error).toBeUndefined();

    // A data response has no hydration to feed — its own wire keeps inlining
    // the plain resolved value exactly as `defer-data-request.spec.ts`
    // already locks in; the settled-thenable shape above is transient, used
    // only while the page tree renders, never part of what this path
    // returns.
    const payload = buildHydrationPayload(rendered.bundle!, "en");
    expect(payload.deferred).toBeUndefined();
    expect(payload.pageData).toEqual({ greeting: "hi", reviews: { rating: 5 } });
  });
});

describe("crawler document — hydration reuses the document-scope deferred registry (item b)", () => {
  type WarlockWindow = typeof globalThis & {
    __WARLOCK_DEFER__?: (key: string, raw: string) => void;
    __WARLOCK_DEFERRED__?: Record<string, unknown>;
  };

  // `defer-registry.ts` only reads `window` as a plain object store (no DOM
  // API) for the calls this spec makes — the SAME assumption
  // `defer-registry.spec.ts` verifies against a real jsdom `window`; this
  // is a minimal stand-in for the ONE thing that differs here (no `use()`
  // rendering, so no real DOM is needed at all).
  const warlockWindow = (): WarlockWindow => globalThis as WarlockWindow;

  afterEach(() => {
    delete warlockWindow().__WARLOCK_DEFER__;
    delete warlockWindow().__WARLOCK_DEFERRED__;
    delete (globalThis as { window?: unknown }).window;
  });

  it("the wire's __WARLOCK_DEFER__ chunk settles the same key hydration prepares — an already-fulfilled promise, not the raw value", async () => {
    const reviews = Promise.resolve({ rating: 5 });
    const entry = pageEntry("/dashboard", deferredPage(reviews));
    const http = createCoreHttp({ url: "/dashboard", headers: { "user-agent": "Googlebot/2.1" } });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    const rendered = await renderPageRequest("/dashboard", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      crawler: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    http.response.setContentType("text/html");
    http.response.setStatusCode(rendered.status);
    await http.response.streamReact(rendered.pipeableStream!);

    const wireHtml = Buffer.concat(chunks).toString("utf8");
    const chunkMatch = /__WARLOCK_DEFER__\("reviews",\s*(".*?")\)/.exec(wireHtml);

    if (chunkMatch === null) {
      throw new Error('no __WARLOCK_DEFER__("reviews", ...) chunk found on the wire');
    }

    // The literal argument the crawler's own document carries — this is the
    // fix's "client hydration" half exercised with the SAME bytes a real
    // browser would run, not a hand-built settlement.
    const rawSettlement = JSON.parse(chunkMatch[1]!) as string;

    const payload = buildHydrationPayload(rendered.bundle!, "en");

    // Red control: revert `render-page.ts` so the crawler branch clears
    // `bundle.deferredKeys` the way it did before this fix. `payload.deferred`
    // comes back `undefined`, the `__WARLOCK_DEFER__` match above never
    // happens (the wire never carries the chunk), and this spec fails at the
    // `chunkMatch === null` throw before it even reaches this assertion.
    expect(payload.deferred).toEqual(["reviews"]);
    // The key that IS deferred-shaped is not also inlined as raw wire data —
    // one representation only, exactly like an ordinary streamed `defer()`
    // page (`buildHydrationPayload`'s `wirePageData`).
    expect(payload.pageData).toEqual({ greeting: "hi" });

    // `prepareDeferredPageData` is what a real hydration does with
    // `payload.deferred` before mounting: it installs `window.__WARLOCK_DEFER__`
    // (`ensureRuntimeDeferHandlerInstalled`) and replaces `pageData.reviews`
    // with a registry-backed promise. Calling the chunk AFTER it, exactly
    // like an ordinary streamed `defer()` page's chunk normally arrives once
    // hydration is already listening (`defer-registry.spec.ts`'s "resolves
    // with the value for a chunk that arrives AFTER prepare").
    // Only installed AFTER the server-side render above completes — the app
    // root's own client/server guard (`shared.ts`) reads `typeof window` to
    // tell the two apart, and this spec is simulating the CLIENT side of the
    // very same request, not a second render.
    (globalThis as { window?: unknown }).window = globalThis;

    const pageData = { ...(payload.pageData as Record<string, unknown>) };

    prepareDeferredPageData(pageData, payload.deferred!);
    warlockWindow().__WARLOCK_DEFER__!("reviews", rawSettlement);

    // Already resolved to the value `use()` on the server just proved it
    // could read — the client's `use(data.reviews)` gets a real, settled
    // promise instead of the plain object the pre-fix wire handed it.
    await expect(pageData.reviews).resolves.toEqual({ rating: 5 });
  });
});
