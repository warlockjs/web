// @vitest-environment jsdom
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { currentNavigator } from "../../routing/navigator";
import { routerEvents } from "../../routing/router-events";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * The client half of card `bb229923`: `fetchPageData` is given a real
 * `AbortController` signal, aborted the moment a newer navigation claims the
 * ticket — but the TICKET (`navigation-root.tsx`'s `claimTicket`/`apply`)
 * stays the arbiter of which response wins. The abort is only an
 * optimisation layered on top of it, proven here by the last test: a
 * superseded response that resolves anyway (its abort effectively ignored)
 * is still dropped.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function payloadOf(name: string): HydrationDocumentPayloadSource {
  return {
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {},
    name,
    locale: "en",
    translations: {},
  };
}

type Gate = { open: () => void; opened: Promise<void> };

function makeGate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { open, opened };
}

/**
 * One controllable response per URL, released only when the test calls the
 * matching gate's `open()` — and each call's `AbortSignal` recorded, so a
 * test can assert on it directly rather than inferring abort from a side
 * effect.
 */
function stubGatedFetch(
  pages: Record<string, HydrationDocumentPayloadSource>,
  options: { respectAbort?: boolean } = {},
): {
  gates: Record<string, Gate>;
  signals: Record<string, AbortSignal>;
  callCount: () => number;
} {
  const respectAbort = options.respectAbort ?? true;
  const gates: Record<string, Gate> = {};
  const signals: Record<string, AbortSignal> = {};

  for (const path of Object.keys(pages)) gates[path] = makeGate();

  let calls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls += 1;

      const url = new URL(String(input), window.location.href);
      const path = url.pathname;
      const payload = pages[path];

      if (payload === undefined) throw new Error(`no stub for ${path}`);
      if (init?.signal) signals[path] = init.signal;

      await gates[path].opened;

      if (respectAbort && init?.signal?.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }

      const headers = new Headers();

      headers.set("content-type", "application/json; charset=utf-8");

      return {
        ok: true,
        status: 200,
        headers,
        url: url.href,
        text: async () => stringify(payload),
      };
    }),
  );

  return { gates, signals, callCount: () => calls };
}

/** Wait for the microtasks a navigation's fetch + tree build need to settle, inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
  window.history.replaceState(null, "", "/a");

  vi.stubGlobal("scrollTo", vi.fn());

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NavigationRoot, {
        pages: [],
        initialPayload: payloadOf("page.a"),
        initialTree: createElement("div", { "data-testid": "page" }, "a"),
        buildTree: async (_pages, payload) =>
          createElement("div", { "data-testid": "page" }, payload.name),
      }),
    );
  });
}

function pageText(): string | null | undefined {
  return container.querySelector('[data-testid="page"]')?.textContent;
}

function listenForErrors(): { errors: unknown[]; stop: () => void } {
  const errors: unknown[] = [];
  const stop = routerEvents.onNavigationError((event) => errors.push(event));

  return { errors, stop };
}

describe("NavigationRoot — abort on a superseded navigation", () => {
  it("aborts the first fetch's signal once a second navigation claims the ticket, and reports no error", async () => {
    const { gates, signals } = stubGatedFetch({
      "/b": payloadOf("page.b"),
      "/c": payloadOf("page.c"),
    });
    const errors = listenForErrors();
    await mount();

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    expect(signals["/b"].aborted).toBe(false);

    act(() => {
      currentNavigator()?.("/c");
    });
    await flush();

    // Claiming the second ticket must have aborted the first's signal.
    expect(signals["/b"].aborted).toBe(true);

    gates["/c"].open();
    await flush();

    expect(pageText()).toBe("page.c");

    // The aborted first request must never have been reported as a
    // navigation error, and must never have fallen back to a hard navigate.
    expect(errors.errors).toEqual([]);

    errors.stop();
  });

  it("keeps the ticket as the arbiter: a superseded response that resolves anyway is still dropped", async () => {
    const { gates } = stubGatedFetch(
      { "/b": payloadOf("page.b"), "/c": payloadOf("page.c") },
      { respectAbort: false },
    );
    const errors = listenForErrors();
    await mount();

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    act(() => {
      currentNavigator()?.("/c");
    });
    await flush();

    // "/c" answers first — the ordinary case.
    gates["/c"].open();
    await flush();

    expect(pageText()).toBe("page.c");

    // "/b"'s abort is ignored by this stub (it answers with real data instead
    // of throwing), simulating a race between the abort signal and a
    // response that was already in flight. The ticket must still drop it.
    gates["/b"].open();
    await flush();

    expect(pageText()).toBe("page.c");
    expect(errors.errors).toEqual([]);

    errors.stop();
  });
});
