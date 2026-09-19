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
 * A client navigation to a URL whose loader answers `response.notFound()`
 * (card c20dbfa2), proven through the real component.
 *
 * The data request for that URL answers 404 with the page's payload
 * (`__tests__/server/page-loader-not-found.spec.ts` pins that wire). The
 * router must NOT render that payload in place — it would mount the page
 * component with data its loader refused to produce, or a blank tree — and
 * must NOT swallow it either. It hands the URL back to the browser, whose
 * full load of the same URL now receives the not-found document.
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

/** Answer every `fetch` the way the server answers a loader `notFound()` data request. */
function stubLoaderNotFoundDataResponse(): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input), window.location.href);
    const headers = new Headers();

    headers.set("content-type", "application/json; charset=utf-8");

    return {
      ok: false,
      status: 404,
      headers,
      url: url.href,
      // A body that PARSES as a payload — the router must still not use it.
      text: async () => stringify(payloadOf("products.show")),
    };
  });

  vi.stubGlobal("fetch", fetchStub);

  return fetchStub;
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
  window.history.replaceState(null, "", "/products");

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

describe("NavigationRoot — a loader notFound() URL", () => {
  it("hands the URL to the browser for a full load instead of rendering the 404 payload in place", async () => {
    const fetchStub = stubLoaderNotFoundDataResponse();
    const buildTree = vi.fn(async (_pages: unknown, payload: HydrationDocumentPayloadSource) =>
      createElement("div", { "data-testid": "page" }, payload.name),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors: { url: string; error: Error }[] = [];
    const stopListening = routerEvents.onNavigationError((event) =>
      errors.push(event as { url: string; error: Error }),
    );

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("products.list"),
          initialTree: createElement("div", { "data-testid": "page" }, "products.list"),
          buildTree,
        }),
      );
    });

    act(() => {
      currentNavigator()?.("/products/missing");
    });
    await flush();

    stopListening();

    expect(fetchStub).toHaveBeenCalledTimes(1);

    // Never rendered in place: no tree was built from the 404 payload, and the
    // committed page is still the one the visitor was on — not a blank root.
    expect(buildTree).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("products.list");

    // The full-load fallback fired for THIS url, for THIS reason. The
    // `window.location.assign(url)` it runs next (jsdom's `Location` is
    // unforgeable, so that call is not spyable; jsdom reports it as "Not
    // implemented: navigation to another Document") is what now lands on the
    // server's 404 document.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.url).toBe("/products/missing");
    expect(errors[0]!.error.message).toBe(
      "Warlock navigation fell back to a full load (status 404): /products/missing",
    );
    expect(warn).toHaveBeenCalledWith(
      "Warlock navigation fell back to a full load (status 404):",
      "/products/missing",
    );
  });
});
