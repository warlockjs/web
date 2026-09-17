// @vitest-environment jsdom
/**
 * Stage 2 slice S3 — the NDJSON client-navigation path (`fetch-page-data.ts`'s
 * `readNdjsonPageData`). Real `ReadableStream` throughout: a hand mock of
 * `.json()` would prove nothing about the line-at-a-time reading this file
 * exists to gate.
 */
import { act, createElement, use, Suspense, Component, type ReactNode } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageData } from "./fetch-page-data";
import { DeferredStreamClosedError } from "../runtime/deferred-stream-closed-error";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** devalue is the page-data wire format — line 1 is devalue-serialized text. */
function payloadLine(deferred?: string[]): string {
  return stringify({
    appData: {},
    layoutData: {},
    pageData: { greeting: "hi" },
    shared: {},
    name: "dashboard",
    locale: "en",
    translations: {},
    ...(deferred ? { deferred } : {}),
  });
}

type StreamHandle = { push: (chunk: string) => void; close: () => void };

/** A controllable NDJSON `Response` double — push lines, close whenever the test wants. */
function ndjsonResponse(contentType = "application/x-ndjson"): {
  response: Response;
  stream: StreamHandle;
} {
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  let close!: () => void;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      close = () => controller.close();
    },
  });

  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    url: "/dashboard",
    body,
  } as unknown as Response;

  return { response, stream: { push, close } };
}

type WarlockWindow = typeof globalThis & { __WARLOCK_DEFERRED__?: unknown };

/** Flush every pending microtask/macrotask so a background stream read settles. */
async function flushAsyncWork(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The registry is a module-level singleton keyed by `window`, which jsdom
  // keeps alive across tests in this file — without this, an earlier test's
  // settled "reviews" entry would silently answer a later test's key.
  delete (window as WarlockWindow).__WARLOCK_DEFERRED__;
});

describe("fetchPageData — NDJSON streaming (Stage 2 slice S3)", () => {
  it("renders line 1 at once (Suspense fallback visible), then the value appears once its line arrives", async () => {
    const { response, stream } = ndjsonResponse();
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const fetchPromise = fetchPageData("/dashboard");
    stream.push(`${payloadLine(["reviews"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");
    const { payload } = result;

    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? createElement("div", null, "errored") : this.props.children;
      }
    }

    function Reviews() {
      const value = use((payload.pageData as { reviews: Promise<{ rating: number }> }).reviews);
      return createElement("div", null, JSON.stringify(value));
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;

    // Awaited: the initial render immediately suspends (`Reviews`'s `use()`
    // sees a pending promise), and React only settles that Suspense boundary
    // properly if the act() call that triggers it is itself awaited.
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(
          Boundary,
          null,
          createElement(
            Suspense,
            { fallback: createElement("div", null, "loading") },
            createElement(Reviews),
          ),
        ),
      );
    });

    // Line 1 has already resolved this navigation — the fallback is on
    // screen, NOT an error, and the value has not arrived yet.
    expect(container.textContent).toBe("loading");

    await act(async () => {
      stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { rating: 5 } }),
        })}\n`,
      );
      stream.close();
      await flushAsyncWork();
    });

    expect(container.textContent).toBe(JSON.stringify({ rating: 5 }));

    root.unmount();
    container.remove();
  });

  it("rejects still-pending keys with DeferredStreamClosedError when the stream ends early", async () => {
    const { response, stream } = ndjsonResponse();
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const fetchPromise = fetchPageData("/dashboard");
    stream.push(`${payloadLine(["reviews"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");

    // The assertion attaches its handler to the derived promise BEFORE the
    // stream closes — attaching AFTER would leave it genuinely unhandled for
    // a few ticks while `flushAsyncWork` runs, which is exactly the
    // transient state Node's `unhandledRejection` detector reports even once
    // a handler eventually arrives.
    const rejected = expect(
      (result.payload.pageData as { reviews: Promise<unknown> }).reviews,
    ).rejects.toBeInstanceOf(DeferredStreamClosedError);

    stream.close();
    await flushAsyncWork();
    await rejected;
  });

  it("a plain JSON response (no ndjson content-type) takes the old path unchanged", async () => {
    const payload = {
      appData: {},
      layoutData: {},
      pageData: { greeting: "hi" },
      shared: {},
      name: "dashboard",
      locale: "en",
      translations: {},
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
        url: "/dashboard",
        text: async () => stringify(payload),
      })),
    );

    const result = await fetchPageData("/dashboard");

    expect(result).toEqual({ type: "payload", payload, url: "/dashboard" });
  });
});
