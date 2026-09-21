// @vitest-environment jsdom
import type { Keywords } from "@mongez/localization";
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { useTrans } from "../../localization";
import { currentNavigator } from "../../routing/navigator";
import { buildHydratedTree } from "../build-hydrated-tree";
import type { ClientPageEntry, ClientRouteComposition } from "../runtime/types";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * Card 79e837e8: a client navigation into a page whose payload carries an
 * app-level translation group (registered server-side only, e.g. an app's
 * own `src/app/*\/utils/locales.ts`) used to throw
 * `IncompleteTranslationRegistrationError` in development and render raw
 * keys in production — the composed page/layout `register()` hooks never
 * learned about that group, and nothing else installed it client-side.
 *
 * `build-hydrated-tree.ts` now installs `payload.translations` itself
 * (`install-payload-translations.ts`), before `registerModules` runs and
 * before components read the table, so this suite proves it end to
 * end through the real `buildHydratedTree` and `NavigationRoot` — not a
 * stub `buildTree` — the same shape `navigation-root-document.spec.ts` uses
 * for the `<html lang dir>` fix.
 */

/** Required by React 19's `act()` to recognize this as a testing environment. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A page component that reads a namespace no register() ever installs. */
function AuthGreeting() {
  const trans = useTrans();

  return createElement("div", { "data-testid": "page" }, String(trans("auth.login")));
}

function entry(
  name: string,
  load: () => ClientRouteComposition | Promise<ClientRouteComposition>,
): ClientPageEntry {
  return { type: "page", name, path: `/${name}`, load };
}

/**
 * A projection whose register() hook is a no-op — the real-world shape of a
 * page whose namespace was registered only server-side (an app-level
 * `locales.ts`), never mirrored into this page's own register().
 */
const pages: ClientPageEntry[] = [
  entry("products.show", () => ({
    Page: { register: () => {}, default: AuthGreeting },
    layouts: [],
  })),
];

function payloadOf(
  name: string,
  locale: string,
  translations: Keywords,
): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData: {}, shared: {}, name, locale, translations };
}

/** Answer every `fetch` with the given payload, echoing back the request URL. */
function stubFetchWith(payload: HydrationDocumentPayloadSource): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input), window.location.href);
    const headers = new Headers();

    headers.set("content-type", "application/json; charset=utf-8");

    return { ok: true, status: 200, headers, url: url.href, text: async () => stringify(payload) };
  });

  vi.stubGlobal("fetch", fetchStub);

  return fetchStub;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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
  // @ts-expect-error test-only mutation of Vite's injected env object
  import.meta.env.DEV = false;
});

describe("client navigation installs the payload's translations", () => {
  it("navigates into a page whose payload carries a group no register() provides, without throwing, and useTrans renders it", async () => {
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = true;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nextPayload = payloadOf("products.show", "en", {
      auth: { login: "Sign in" },
    });
    stubFetchWith(nextPayload);

    const initialPayload = payloadOf("products.list", "en", {});

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages,
          initialPayload,
          initialTree: createElement("div", { "data-testid": "page" }, "products.list"),
          buildTree: buildHydratedTree,
        }),
      );
    });

    act(() => {
      currentNavigator()?.("/products/1");
    });
    await flush();

    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("Sign in");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
