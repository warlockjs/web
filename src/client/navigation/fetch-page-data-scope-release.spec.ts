// @vitest-environment jsdom
/**
 * Stage 2 slice S3 — scope release for the three settlement outcomes
 * `fetch-page-data-ndjson.spec.ts` does not already cover: a rejection
 * chunk, a malformed NDJSON line mid-stream, and a stream that closes before
 * every declared deferred key has settled. Each case asserts the
 * navigation's own scope is fully gone from the registry once its
 * background reader drains, and that the document scope is untouched by it.
 */
import { act } from "react";
import { stringify } from "devalue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageData } from "./fetch-page-data";
import { DeferredStreamClosedError } from "../runtime/deferred-stream-closed-error";
import {
  prepareDeferredPageData,
  settleDeferredValue,
  DOCUMENT_SCOPE,
} from "../runtime/defer-registry";

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
};

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

type WarlockWindow = typeof globalThis & { __WARLOCK_DEFERRED__?: Record<string, unknown> };

function registrySize(): number {
  const registry = (window as WarlockWindow).__WARLOCK_DEFERRED__;
  return registry === undefined ? 0 : Object.keys(registry).length;
}

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
  // entry would silently answer a later test's key.
  delete (window as WarlockWindow).__WARLOCK_DEFERRED__;
});

describe("fetchPageData — NDJSON scope release on rejection, malformed lines, and early close", () => {
  it("releases the scope once a deferred key settles via a REJECTION chunk", async () => {
    // A document-scoped entry, so we can assert it survives the navigation
    // scope's release untouched.
    const documentPageData: Record<string, unknown> = {};
    prepareDeferredPageData(documentPageData, ["greeting"]);
    settleDeferredValue("greeting", { ok: true, value: "hi" }, DOCUMENT_SCOPE);

    const { response, stream } = ndjsonResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const fetchPromise = fetchPageData("/dashboard");
    stream.push(`${payloadLine(["reviews"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");

    const reviews = (result.payload.pageData as { reviews: Promise<unknown> }).reviews;
    const rejected = expect(reviews).rejects.toBeInstanceOf(Error);

    await act(async () => {
      stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({
            ok: false,
            error: { name: "ReviewsFetchError", message: "reviews service is down" },
          }),
        })}\n`,
      );
      stream.close();
      await flushAsyncWork();
    });

    await rejected;

    // The navigation scope is fully drained (its only key settled via the
    // rejection chunk), so `releaseDeferredScope` removes it entirely.
    expect(registrySize()).toBe(1);
    await expect(documentPageData.greeting).resolves.toBe("hi");
  });

  it("rejects a key whose settlement is malformed, and still releases the scope", async () => {
    // A well-formed `defer` line whose `settlement` is not valid devalue text.
    // The key must stay pending until the stream ends, so the close path
    // rejects it and `releaseDeferredScope` can then remove it. Dropping it
    // from `pending` before the parse left it unsettled and leaked forever.
    const documentPageData: Record<string, unknown> = {};
    prepareDeferredPageData(documentPageData, ["greeting"]);
    settleDeferredValue("greeting", { ok: true, value: "hi" }, DOCUMENT_SCOPE);

    const { response, stream } = ndjsonResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const fetchPromise = fetchPageData("/dashboard");
    stream.push(`${payloadLine(["reviews"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");

    const reviews = (result.payload.pageData as { reviews: Promise<unknown> }).reviews;

    let settled = false;
    void reviews.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await act(async () => {
      // `defer` names a real declared key, but `settlement` is not valid
      // devalue text — the malformed piece of an otherwise well-formed line.
      stream.push(`${JSON.stringify({ defer: "reviews", settlement: "not valid devalue" })}\n`);
      stream.close();
      await flushAsyncWork();
    });

    // Settled by rejection, and the navigation scope is gone: only the
    // document entry remains.
    expect(settled).toBe(true);
    await expect(reviews).rejects.toBeInstanceOf(DeferredStreamClosedError);
    expect(registrySize()).toBe(1);
    await expect(documentPageData.greeting).resolves.toBe("hi");
  });

  it("rejects still-pending keys and releases the scope when the stream closes before every declared key settles", async () => {
    const documentPageData: Record<string, unknown> = {};
    prepareDeferredPageData(documentPageData, ["greeting"]);
    settleDeferredValue("greeting", { ok: true, value: "hi" }, DOCUMENT_SCOPE);

    const { response, stream } = ndjsonResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const fetchPromise = fetchPageData("/dashboard");
    stream.push(`${payloadLine(["reviews", "comments"])}\n`);

    const result = await fetchPromise;
    if (result.type !== "payload") throw new Error("expected a payload result");

    const { reviews, comments } = result.payload.pageData as {
      reviews: Promise<unknown>;
      comments: Promise<unknown>;
    };

    const reviewsResolved = expect(reviews).resolves.toEqual({ rating: 5 });
    const commentsRejected = expect(comments).rejects.toBeInstanceOf(DeferredStreamClosedError);

    await act(async () => {
      // Only "reviews" gets a settlement chunk; "comments" never does before
      // the stream closes.
      stream.push(
        `${JSON.stringify({
          defer: "reviews",
          settlement: stringify({ ok: true, value: { rating: 5 } }),
        })}\n`,
      );
      stream.close();
      await flushAsyncWork();
    });

    await reviewsResolved;
    await commentsRejected;

    // Both keys are now settled (one resolved, one stream-closed-rejected),
    // so the whole navigation scope is released — only the document entry
    // remains.
    expect(registrySize()).toBe(1);
    await expect(documentPageData.greeting).resolves.toBe("hi");
  });
});
