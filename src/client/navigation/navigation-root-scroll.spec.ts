// @vitest-environment jsdom
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { currentNavigator } from "../../routing/navigator";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * Scroll restoration, proven end to end through the real component: the
 * decision logic lives in `scroll-restoration.spec.ts`, but only mounting
 * `NavigationRoot` proves it is wired to the right moment — AFTER React has
 * committed the swapped page, never before (`navigation-root.tsx`'s
 * `useLayoutEffect`).
 *
 * `window.scrollTo` is spied rather than trusted to move anything: jsdom does
 * not implement scrolling (no layout), so the only observable fact is which
 * coordinates the router asked for.
 */

/** Required by React 19's `act()` to recognize this as a testing environment. */
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

/** Answer every `fetch` with the payload for the URL it asked for. */
function stubFetchFor(pages: Record<string, HydrationDocumentPayloadSource>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), window.location.href);
      const payload = pages[url.pathname];

      if (payload === undefined) throw new Error(`no stub for ${url.pathname}`);

      const headers = new Headers();

      headers.set("content-type", "application/json; charset=utf-8");

      return {
        ok: true,
        status: 200,
        headers,
        url: url.href,
        // devalue is the page-data wire format: `fetchPageData` reads
        // `.text()` and decodes it with devalue's `parse`, never `.json()`.
        text: async () => stringify(payload),
      };
    }),
  );
}

/** Wait for the microtasks a navigation's fetch + tree build need to settle, inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setScroll(x: number, y: number): void {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

/**
 * jsdom's `history.back()`/`forward()` are genuinely asynchronous — location
 * and the resulting `popstate` land a task later, not in the same microtask
 * turn — so driving them for real (rather than dispatching a synthetic
 * `PopStateEvent`, which would fire before jsdom itself has moved
 * `window.location`) means waiting a real tick for jsdom's own traversal task
 * to run first.
 */
async function goBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await flush();
}

async function goForward(): Promise<void> {
  await act(async () => {
    window.history.forward();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await flush();
}

let container: HTMLDivElement;
let root: Root;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();

  window.history.replaceState(null, "", "/a");

  scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);

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

describe("NavigationRoot — scroll restoration boot", () => {
  it("sets history.scrollRestoration to manual on mount", async () => {
    await mount();

    expect(window.history.scrollRestoration).toBe("manual");
  });
});

describe("NavigationRoot — a new navigation", () => {
  it("scrolls to the top after the new page has rendered", async () => {
    stubFetchFor({ "/b": payloadOf("page.b") });
    await mount();

    setScroll(0, 500);

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    expect(pageText()).toBe("page.b");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("defers to the fragment instead of the top when the URL has a hash", async () => {
    stubFetchFor({ "/b": payloadOf("page.b") });
    await mount();

    act(() => {
      currentNavigator()?.("/b#section");
    });
    await flush();

    expect(pageText()).toBe("page.b");
    // No target with that id exists on this page, so nothing is found to
    // scroll to — the claim under test is that top-of-page was NOT requested
    // as a fallback.
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("NavigationRoot — Back/Forward", () => {
  it("restores the position that was saved when the entry was left", async () => {
    stubFetchFor({ "/a": payloadOf("page.a"), "/b": payloadOf("page.b") });
    await mount();

    setScroll(0, 640);

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    scrollTo.mockClear();

    await goBack();

    expect(pageText()).toBe("page.a");
    expect(scrollTo).toHaveBeenCalledWith(0, 640);
  });

  it("restores the position again on Forward", async () => {
    stubFetchFor({ "/a": payloadOf("page.a"), "/b": payloadOf("page.b") });
    await mount();

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    setScroll(0, 300);

    await goBack();

    scrollTo.mockClear();

    await goForward();

    expect(pageText()).toBe("page.b");
    expect(scrollTo).toHaveBeenCalledWith(0, 300);
  });

  it("prefers the saved position over the entry's own hash", async () => {
    stubFetchFor({ "/a": payloadOf("page.a"), "/b": payloadOf("page.b") });
    await mount();

    act(() => {
      currentNavigator()?.("/b#section");
    });
    await flush();

    // The user scrolled on B (whose URL still names `#section`) before
    // pressing Back — this is the position that must win over the hash when
    // Forward returns to B.
    setScroll(0, 411);

    await goBack();

    scrollTo.mockClear();

    await goForward();

    expect(pageText()).toBe("page.b");
    expect(scrollTo).toHaveBeenCalledWith(0, 411);
  });
});
