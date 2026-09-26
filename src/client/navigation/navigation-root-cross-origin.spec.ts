// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { currentNavigator } from "../../routing/navigator";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * A link to another site (`href()` across sites) is an absolute URL on another
 * origin. That document is not this runtime's to fetch or swap, so the
 * navigator declines and `<Link>` leaves the click to the browser.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function payloadOf(name: string): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData: {}, shared: {}, name, locale: "en", translations: {} };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
  window.history.replaceState(null, "", "/");
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

describe("NavigationRoot — a URL on another origin", () => {
  it("declines it without fetching, so the browser follows the link", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("landing.index"),
          initialTree: createElement("div", null, "landing"),
          buildTree: vi.fn(),
        }),
      );
    });

    let accepted: boolean | undefined;
    act(() => {
      accepted = currentNavigator()?.("http://app.localhost:2030/");
    });

    expect(accepted).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
});
