// @vitest-environment jsdom
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { currentNavigator } from "../../routing/navigator";
import { prepareDeferredPageData, settleDeferredValue } from "../runtime/defer-registry";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * Card `75a46e70`: the initial document's deferred scope has no reader of its
 * own to release it — `apply` (`navigation-root.tsx`) does it once, right
 * after the FIRST client navigation's `applySwap`, guarded by
 * `documentScopeReleased` so a later navigation never calls it again. These
 * tests drive that through a real navigation, exactly the way
 * `navigation-root-abort.spec.ts` does, and read the registry the same way
 * `defer-registry.spec.ts` does — through `window.__WARLOCK_DEFERRED__`
 * directly, since that is the one surface both the module under test and this
 * spec can observe.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type WarlockWindow = typeof globalThis & {
  __WARLOCK_DEFERRED__?: Record<string, unknown>;
};

function registrySize(): number {
  return Object.keys((window as WarlockWindow).__WARLOCK_DEFERRED__ ?? {}).length;
}

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

/** Answers every fetch with `pages[pathname]`, the same shape `navigation-root-default-boundary.spec.ts` uses. */
function stubFetchMap(pages: Record<string, HydrationDocumentPayloadSource>): void {
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
  window.history.replaceState(null, "", "/a");
  delete (window as WarlockWindow).__WARLOCK_DEFERRED__;

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
  delete (window as WarlockWindow).__WARLOCK_DEFERRED__;
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

describe("NavigationRoot — releases the document deferred scope after the first client navigation (card 75a46e70)", () => {
  it("has settled DOCUMENT_SCOPE entries in the registry before any navigation happens", async () => {
    const pageData: Record<string, unknown> = {};

    prepareDeferredPageData(pageData, ["reviews"]);
    settleDeferredValue("reviews", { ok: true, value: { count: 1 } });

    await mount();

    expect(registrySize()).toBe(1);
  });

  it("removes the settled DOCUMENT_SCOPE entries once the first client navigation applies", async () => {
    const pageData: Record<string, unknown> = {};

    prepareDeferredPageData(pageData, ["reviews"]);
    settleDeferredValue("reviews", { ok: true, value: { count: 1 } });

    stubFetchMap({ "/b": payloadOf("page.b") });
    await mount();

    expect(registrySize()).toBe(1);

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    expect(pageText()).toBe("page.b");
    expect(registrySize()).toBe(0);
  });

  it("does not throw or re-release the document scope on a second navigation", async () => {
    const pageData: Record<string, unknown> = {};

    prepareDeferredPageData(pageData, ["reviews"]);
    settleDeferredValue("reviews", { ok: true, value: { count: 1 } });

    stubFetchMap({ "/b": payloadOf("page.b"), "/c": payloadOf("page.c") });
    await mount();

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    expect(registrySize()).toBe(0);

    // A settled entry created AFTER the first release, still scoped to
    // DOCUMENT_SCOPE, to prove a second navigation does not call
    // `releaseDeferredScope(DOCUMENT_SCOPE)` again — if it did, this would be
    // swept up too even though nothing here re-armed the ref that guards it.
    settleDeferredValue("late", { ok: true, value: 1 });
    expect(registrySize()).toBe(1);

    await expect(
      act(async () => {
        currentNavigator()?.("/c");
        await flush();
      }),
    ).resolves.not.toThrow();

    expect(pageText()).toBe("page.c");
    expect(registrySize()).toBe(1);
  });

  it("leaves a still-pending DOCUMENT_SCOPE entry alone at navigation time", async () => {
    const pageData: Record<string, unknown> = {};

    // Never settled — the release must skip it (`releaseDeferredScope` only
    // deletes settled entries; see `defer-registry.ts`).
    prepareDeferredPageData(pageData, ["reviews"]);

    stubFetchMap({ "/b": payloadOf("page.b") });
    await mount();

    expect(registrySize()).toBe(1);

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    expect(pageText()).toBe("page.b");
    expect(registrySize()).toBe(1);

    // Still readable — the entry was never deleted out from under it.
    settleDeferredValue("reviews", { ok: true, value: { count: 2 } });
    await expect(pageData.reviews).resolves.toEqual({ count: 2 });
  });
});
