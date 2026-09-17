// @vitest-environment jsdom
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { changeLocaleCode } from "./change-locale-code";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * `document.documentElement`'s `lang`/`dir` after a client-side locale
 * change, proven end to end through the real component.
 *
 * The defect: `changeLocaleCode("ar")` updated `useLocale()`/
 * `useTextDirection()` in-page, but `documentElement` kept whatever the last
 * full load set (`lang="en" dir="ltr"`) until a reload — `root.tsx` sits
 * outside the hydrated subtree (`skills/write-the-root/SKILL.md`), so no
 * client render reaches it. `sync-document-locale.spec.ts` proves the
 * correction function in isolation; only mounting `NavigationRoot` proves it
 * is actually wired to a locale swap.
 */

/** Required by React 19's `act()` to recognize this as a testing environment. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function payloadOf(name: string, locale: string): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData: {}, shared: {}, name, locale, translations: {} };
}

/** Answer every `fetch` with the payload for whichever locale the request asked for. */
function stubFetchByLocaleParam(payloads: Record<string, HydrationDocumentPayloadSource>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input), window.location.href);
      const code = url.searchParams.get("locale");
      const payload = code === null ? undefined : payloads[code];

      if (payload === undefined) throw new Error(`no stub for locale ${String(code)}`);

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

/** Wait for the microtasks a locale change's fetch + tree build need to settle, inside `act`. */
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

  // The state a real full load in English leaves the document in
  // (`components/default-app.tsx:25`) — what a stale `documentElement`
  // looks like before any client-side locale change runs.
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";

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
  document.documentElement.lang = "";
  document.documentElement.dir = "";
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NavigationRoot, {
        pages: [],
        initialPayload: payloadOf("products.list", "en"),
        initialTree: createElement("div", { "data-testid": "page" }, "en"),
        buildTree: async (_pages, payload) =>
          createElement("div", { "data-testid": "page" }, payload.locale),
      }),
    );
  });
}

describe("NavigationRoot — documentElement follows a locale change", () => {
  it("does not touch documentElement on mount, when it already matches the hydration locale", async () => {
    await mount();

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("sets lang and dir after changeLocaleCode swaps to ar, and back after swapping to en", async () => {
    stubFetchByLocaleParam({
      ar: payloadOf("products.list", "ar"),
      en: payloadOf("products.list", "en"),
    });
    await mount();

    await act(async () => {
      await changeLocaleCode("ar");
    });
    await flush();

    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");

    await act(async () => {
      await changeLocaleCode("en");
    });
    await flush();

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
