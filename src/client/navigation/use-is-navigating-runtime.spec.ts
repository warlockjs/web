// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { currentNavigator } from "../../routing/navigator";
import type { ClientPageEntry } from "../runtime";
import { NavigationRoot } from "./navigation-root";
import { readNavigationPending } from "./navigation-pending-store";
import { refresh } from "./refresh";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";
import { useIsNavigating } from "./use-is-navigating";

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

function stubGatedFetch(
  pages: Record<string, HydrationDocumentPayloadSource>,
  respectAbort = true,
): Record<string, Gate> {
  const gates = Object.fromEntries(Object.keys(pages).map((path) => [path, makeGate()])) as Record<
    string,
    Gate
  >;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.href);
      const gate = gates[url.pathname];
      const payload = pages[url.pathname];

      if (gate === undefined || payload === undefined)
        throw new Error(`No response for ${url.pathname}`);

      await gate.opened;

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

  return gates;
}

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

function PendingProbe({ renders }: { renders: boolean[] }): ReactNode {
  const pending = useIsNavigating();
  renders.push(pending);
  return createElement("output", { "data-testid": "pending" }, String(pending));
}

function page(name: string, renders?: boolean[]): ReactNode {
  return createElement(
    "main",
    { "data-testid": "page" },
    name,
    renders === undefined ? undefined : createElement(PendingProbe, { renders }),
  );
}

async function mount(
  initialTree: ReactNode,
  buildTree: (
    _pages: readonly ClientPageEntry[],
    payload: HydrationDocumentPayloadSource,
  ) => Promise<ReactNode>,
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NavigationRoot, {
        pages: [],
        initialPayload: payloadOf("page.a"),
        initialTree,
        buildTree,
      }),
    );
  });
}

function pendingText(): string | null | undefined {
  return container.querySelector('[data-testid="pending"]')?.textContent;
}

describe("useIsNavigating through NavigationRoot", () => {
  it("lets a hook mounted by the destination tree observe pending until that tree commits", async () => {
    const renders: boolean[] = [];
    const gates = stubGatedFetch({ "/b": payloadOf("page.b") });

    await mount(page("a"), async (_pages, payload) => page(payload.name, renders));

    act(() => {
      currentNavigator()?.("/b");
    });
    expect(container.querySelector('[data-testid="pending"]')).toBeNull();
    expect(readNavigationPending()).toBe(true);

    gates["/b"]!.open();
    await flush();

    // The destination hook first rendered while its ticket was pending. The
    // following render is from NavigationRoot's post-commit layout effect.
    expect(renders).toEqual([true, false]);
    expect(pendingText()).toBe("false");
  });

  it("keeps refresh pending through its committed replacement and clears it after a build error", async () => {
    const renders: boolean[] = [];
    const gates = stubGatedFetch({ "/a": payloadOf("page.a") });

    await mount(page("a", renders), async (_pages, payload) => page(payload.name, renders));
    renders.length = 0;

    let successfulRefresh: Promise<boolean>;
    act(() => {
      successfulRefresh = refresh();
    });
    expect(pendingText()).toBe("true");
    gates["/a"]!.open();
    await expect(successfulRefresh!).resolves.toBe(true);
    await flush();

    expect(renders).toContain(true);
    expect(pendingText()).toBe("false");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
        return {
          ok: true,
          status: 200,
          headers,
          url: window.location.href,
          text: async () => stringify(payloadOf("page.a")),
        };
      }),
    );

    await mount(page("a", renders), async () => {
      throw new Error("page chunk failed");
    });

    await expect(refresh()).resolves.toBe(false);
    expect(readNavigationPending()).toBe(false);
  });

  it("does not let a superseded completion clear the current ticket, and root cleanup clears its own ticket", async () => {
    const renders: boolean[] = [];
    const gates = stubGatedFetch({ "/b": payloadOf("page.b"), "/c": payloadOf("page.c") }, false);

    await mount(page("a", renders), async (_pages, payload) => page(payload.name, renders));

    act(() => {
      currentNavigator()?.("/b");
      currentNavigator()?.("/c");
    });
    expect(pendingText()).toBe("true");

    gates["/b"]!.open();
    await flush();
    expect(pendingText()).toBe("true");

    gates["/c"]!.open();
    await flush();
    expect(pendingText()).toBe("false");

    const cleanupGates = stubGatedFetch({ "/d": payloadOf("page.d") });
    act(() => {
      currentNavigator()?.("/d");
    });
    expect(readNavigationPending()).toBe(true);
    act(() => root.unmount());
    expect(readNavigationPending()).toBe(false);
    cleanupGates["/d"]!.open();
  });
});
