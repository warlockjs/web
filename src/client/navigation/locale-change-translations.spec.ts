// @vitest-environment jsdom
import type { Keywords } from "@mongez/localization";
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { useTrans } from "../../localization";
import { buildHydratedTree } from "../build-hydrated-tree";
import type { ClientPageEntry, ClientRouteComposition } from "../runtime/types";
import { changeLocaleCode } from "./change-locale-code";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * Card 79e837e8: `changeLocaleCode("ar")` on a route whose translations
 * include an app-level group (`auth`, `validation`, `http`, `attributes`,
 * `starter`, `site` in the reported case) used to throw
 * `IncompleteTranslationRegistrationError` in development — the composed
 * page's `register()` never installed that group for `ar`, and nothing else
 * did either — and rendered raw keys in production. Proven end to end
 * through the real `buildHydratedTree` and `NavigationRoot`, not a stub
 * `buildTree`, the same shape `navigation-root-document.spec.ts` already
 * uses for the sibling `<html lang dir>` fix.
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

/** Answer every `fetch` with the payload for whichever `?locale=` the request carried. */
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
        text: async () => stringify(payload),
      };
    }),
  );
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
  window.history.replaceState(null, "", "/products/1");
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
  // @ts-expect-error test-only mutation of Vite's injected env object
  import.meta.env.DEV = false;
});

/**
 * Built through the real `buildHydratedTree` — exactly what `entry/index.ts`
 * does for the hydration render — so the initial mount installs
 * `initialPayload.translations` the same way a navigation later does, rather
 * than this harness quietly pre-seeding the table itself.
 */
async function mount(initialPayload: HydrationDocumentPayloadSource): Promise<void> {
  const initialTree = await buildHydratedTree(pages, initialPayload);

  await act(async () => {
    root.render(
      createElement(NavigationRoot, {
        pages,
        initialPayload,
        initialTree,
        buildTree: buildHydratedTree,
      }),
    );
  });
}

describe("changeLocaleCode installs the payload's translations", () => {
  it("switches locale into a group no register() provides, without throwing, and useTrans renders it", async () => {
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = true;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    stubFetchByLocaleParam({
      ar: payloadOf("products.show", "ar", { auth: { login: "تسجيل الدخول" } }),
    });

    await mount(payloadOf("products.show", "en", { auth: { login: "Sign in" } }));

    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("Sign in");

    await act(async () => {
      await changeLocaleCode("ar");
    });
    await flush();

    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("تسجيل الدخول");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
