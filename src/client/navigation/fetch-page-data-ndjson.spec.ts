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

type StreamHandle = {
  push: (chunk: string) => void;
  close: () => void;
  /** Simulate the stream breaking mid-read — an abort is the realistic cause. */
  error: (reason: unknown) => void;
};

/** A controllable NDJSON `Response` double — push lines, close whenever the test wants. */
function ndjsonResponse(contentType = "application/x-ndjson"): {
  response: Response;
  stream: StreamHandle;
} {
  const encoder = new TextEncoder();
  let push!: (chunk: string) => void;
  let close!: () => void;
  let error!: (reason: unknown) => void;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      close = () => controller.close();
      error = (reason: unknown) => controller.error(reason);
    },
  });

  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    url: "/dashboard",
    body,
  } as unknown as Response;

  return { response, stream: { push, close, error } };
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

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

  it("rejects still-pending keys when the navigation is aborted mid-stream, same as a stream that ends early", async () => {
    const { response, stream } = ndjsonResponse();
    const controller = new AbortController();

    // Line 1 has already arrived (the fetch itself resolved) by the time the
    // caller aborts — this is the "abort landed after the response started
    // streaming" case `readNdjsonPageData`'s own doc names.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          stream.error(new DOMException("The user aborted a request.", "AbortError"));
        });

        return response;
      }),
    );

    const fetchPromise = fetchPageData("/dashboard", controller.signal);
    stream.push(`${payloadLine(["reviews"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");

    const rejected = expect(
      (result.payload.pageData as { reviews: Promise<unknown> }).reviews,
    ).rejects.toBeInstanceOf(DeferredStreamClosedError);

    controller.abort();
    await flushAsyncWork();
    await rejected;
  });

  it("does not leak one navigation's deferred settlement into a concurrent navigation's same-named key", async () => {
    const first = ndjsonResponse();
    const second = ndjsonResponse();
    const responses = [first.response, second.response];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    // Two overlapping navigations, each deferring a key named "reviews" —
    // e.g. two product pages navigated to in quick succession.
    const firstPromise = fetchPageData("/product-a");
    const secondPromise = fetchPageData("/product-b");

    first.stream.push(`${payloadLine(["reviews"])}\n`);
    second.stream.push(`${payloadLine(["reviews"])}\n`);

    const firstResult = await firstPromise;
    const secondResult = await secondPromise;
    if (firstResult.type !== "payload" || secondResult.type !== "payload") {
      throw new Error("expected both to be payload results");
    }

    const firstReviews = (firstResult.payload.pageData as { reviews: Promise<unknown> }).reviews;
    const secondReviews = (secondResult.payload.pageData as { reviews: Promise<unknown> }).reviews;

    // Only the FIRST navigation's settlement arrives; the second's stream
    // never sends its own "reviews" line before this assertion.
    await act(async () => {
      first.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { productId: "a" } }),
        })}\n`,
      );
      first.stream.close();
      await flushAsyncWork();
    });

    await expect(firstReviews).resolves.toEqual({ productId: "a" });

    // The second navigation's own key must still be UNSETTLED — it must not
    // have been resolved by the first navigation's chunk just because both
    // used the same key name "reviews".
    let secondSettled = false;
    void secondReviews.then(() => {
      secondSettled = true;
    });
    await flushAsyncWork();
    expect(secondSettled).toBe(false);

    await act(async () => {
      second.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { productId: "b" } }),
        })}\n`,
      );
      second.stream.close();
      await flushAsyncWork();
    });

    await expect(secondReviews).resolves.toEqual({ productId: "b" });
  });

  it("a REJECTED settlement in one navigation never settles a concurrent navigation's same-named key", async () => {
    const first = ndjsonResponse();
    const second = ndjsonResponse();
    const responses = [first.response, second.response];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    const firstPromise = fetchPageData("/product-a");
    const secondPromise = fetchPageData("/product-b");

    first.stream.push(`${payloadLine(["reviews"])}\n`);
    second.stream.push(`${payloadLine(["reviews"])}\n`);

    const firstResult = await firstPromise;
    const secondResult = await secondPromise;
    if (firstResult.type !== "payload" || secondResult.type !== "payload") {
      throw new Error("expected both to be payload results");
    }

    const firstReviews = (firstResult.payload.pageData as { reviews: Promise<unknown> }).reviews;
    const secondReviews = (secondResult.payload.pageData as { reviews: Promise<unknown> }).reviews;

    // Only the FIRST navigation's stream sends an error settlement for
    // "reviews"; the second's own key must stay pending.
    const rejected = expect(firstReviews).rejects.toBeInstanceOf(Error);

    await act(async () => {
      first.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({
            ok: false,
            error: { name: "ReviewsFetchError", message: "reviews service is down" },
          }),
        })}\n`,
      );
      first.stream.close();
      await flushAsyncWork();
    });

    await rejected;
    await expect(firstReviews).rejects.toMatchObject({ message: "reviews service is down" });

    let secondSettled = false;
    void secondReviews.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await flushAsyncWork();
    expect(secondSettled).toBe(false);

    await act(async () => {
      second.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { productId: "b" } }),
        })}\n`,
      );
      second.stream.close();
      await flushAsyncWork();
    });

    await expect(secondReviews).resolves.toEqual({ productId: "b" });
  });

  it("a STREAM-CLOSE rejection in one navigation never settles a concurrent navigation's same-named pending key", async () => {
    const first = ndjsonResponse();
    const second = ndjsonResponse();
    const responses = [first.response, second.response];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    const firstPromise = fetchPageData("/product-a");
    const secondPromise = fetchPageData("/product-b");

    first.stream.push(`${payloadLine(["reviews"])}\n`);
    second.stream.push(`${payloadLine(["reviews"])}\n`);

    const firstResult = await firstPromise;
    const secondResult = await secondPromise;
    if (firstResult.type !== "payload" || secondResult.type !== "payload") {
      throw new Error("expected both to be payload results");
    }

    const firstReviews = (firstResult.payload.pageData as { reviews: Promise<unknown> }).reviews;
    const secondReviews = (secondResult.payload.pageData as { reviews: Promise<unknown> }).reviews;

    // Only the FIRST navigation's stream closes early — its own "reviews"
    // key never gets a chunk. The second navigation's stream stays open.
    const rejected = expect(firstReviews).rejects.toBeInstanceOf(DeferredStreamClosedError);

    await act(async () => {
      first.stream.close();
      await flushAsyncWork();
    });

    await rejected;

    let secondSettled = false;
    void secondReviews.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await flushAsyncWork();
    expect(secondSettled).toBe(false);

    await act(async () => {
      second.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { productId: "b" } }),
        })}\n`,
      );
      second.stream.close();
      await flushAsyncWork();
    });

    await expect(secondReviews).resolves.toEqual({ productId: "b" });
  });

  it("releases a completed navigation's scope from the registry — size stays bounded across N navigations", async () => {
    const navigationCount = 5;

    for (let i = 0; i < navigationCount; i += 1) {
      const { response, stream } = ndjsonResponse();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );

      const fetchPromise = fetchPageData(`/product-${i}`);
      stream.push(`${payloadLine(["reviews"])}\n`);

      const result = await fetchPromise;
      if (result.type !== "payload") throw new Error("expected a payload result");

      await act(async () => {
        stream.push(
          `${JSON.stringify({
            defer: "reviews",
            settlement: stringify({ ok: true, value: { productId: i } }),
          })}\n`,
        );
        stream.close();
        await flushAsyncWork();
      });

      await expect(
        (result.payload.pageData as { reviews: Promise<unknown> }).reviews,
      ).resolves.toEqual({ productId: i });

      const registry = (window as WarlockWindow).__WARLOCK_DEFERRED__ as
        Record<string, unknown> | undefined;
      const size = registry === undefined ? 0 : Object.keys(registry).length;

      // Bounded, not proportional to how many navigations have happened —
      // a leak would grow this by one entry per navigation.
      expect(size).toBeLessThanOrEqual(1);
    }
  });

  it("a superseded navigation's scope is released once its stream is aborted", async () => {
    const { response, stream } = ndjsonResponse();
    const controller = new AbortController();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          stream.error(new DOMException("The user aborted a request.", "AbortError"));
        });

        return response;
      }),
    );

    const fetchPromise = fetchPageData("/dashboard", controller.signal);
    stream.push(`${payloadLine(["reviews"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");

    const rejected = expect(
      (result.payload.pageData as { reviews: Promise<unknown> }).reviews,
    ).rejects.toBeInstanceOf(DeferredStreamClosedError);

    controller.abort();
    await flushAsyncWork();
    await rejected;

    const registry = (window as WarlockWindow).__WARLOCK_DEFERRED__ as
      Record<string, unknown> | undefined;

    expect(Object.keys(registry ?? {})).toHaveLength(0);
  });

  it("the current page's deferred value still resolves after the next navigation starts, before it applies", async () => {
    const first = ndjsonResponse();
    const second = ndjsonResponse();
    const responses = [first.response, second.response];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses.shift()!),
    );

    const firstPromise = fetchPageData("/product-a");
    first.stream.push(`${payloadLine(["reviews"])}\n`);

    const firstResult = await firstPromise;
    if (firstResult.type !== "payload") throw new Error("expected a payload result");
    const firstReviews = (firstResult.payload.pageData as { reviews: Promise<unknown> }).reviews;

    // The next navigation STARTS — its own fetch is issued — before the
    // first page's deferred value has settled, and without aborting the
    // first navigation's still-streaming response.
    const secondPromise = fetchPageData("/product-b");
    second.stream.push(`${payloadLine(["reviews"])}\n`);
    const secondResult = await secondPromise;
    if (secondResult.type !== "payload") throw new Error("expected a payload result");

    // The first page's own deferred value settles while the second
    // navigation is in flight but has not applied yet.
    await act(async () => {
      first.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { productId: "a" } }),
        })}\n`,
      );
      first.stream.close();
      await flushAsyncWork();
    });

    await expect(firstReviews).resolves.toEqual({ productId: "a" });

    const secondReviews = (secondResult.payload.pageData as { reviews: Promise<unknown> }).reviews;

    await act(async () => {
      second.stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { productId: "b" } }),
        })}\n`,
      );
      second.stream.close();
      await flushAsyncWork();
    });

    await expect(secondReviews).resolves.toEqual({ productId: "b" });
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
