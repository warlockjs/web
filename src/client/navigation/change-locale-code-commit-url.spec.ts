import { stringify } from "devalue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { publishLocaleRouting } from "../../routing/locale-routing";
import { createLocaleChanger } from "./change-locale-code";
import type { RefreshRuntime, RefreshablePage } from "./refresh";

/**
 * Under a locale-routing strategy the URL write must go through the runtime's
 * `commitUrl`, never straight to `history.pushState` — otherwise the runtime's
 * `committedUrl` goes stale and Back onto the old-locale URL is treated as a
 * hash-only move (the wrong-language page stays on screen).
 */

function payloadOf(locale: string): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData: {}, shared: {}, name: "about", locale, translations: {} };
}

function stubBrowser(href: string) {
  const pushState = vi.fn();
  const replaceState = vi.fn();

  vi.stubGlobal("window", {
    location: { href, protocol: "https:", assign: vi.fn() },
    history: { pushState, replaceState },
  });
  vi.stubGlobal("document", { documentElement: { lang: "en", dir: "ltr" }, cookie: "" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const locale = new URL(url).pathname.startsWith("/ar") ? "ar" : "en";

      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
        url,
        text: async () => stringify(payloadOf(locale)),
      };
    }),
  );

  return { pushState, replaceState };
}

function runtimeOn(locale: string) {
  let current: RefreshablePage = {
    payload: payloadOf(locale),
    tree: "tree",
    routeSource: payloadOf(locale),
  };
  let token = 0;
  const commitUrl = vi.fn();
  const runtime: RefreshRuntime = {
    readCurrent: () => current,
    writeCurrent: (page) => {
      current = page;
    },
    buildTree: async () => "tree",
    commitUrl,
    claimTicket: () => {
      const ticket = ++token;

      return { isCurrent: () => ticket === token, signal: new AbortController().signal };
    },
  };

  return { runtime, commitUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
  publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" });
});

describe("changeLocaleCode — history writes go through the runtime (B1)", () => {
  it("/about → ar commits /ar/about, and ar → en commits /about, via commitUrl", async () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const browser = stubBrowser("https://app.test/about");
    const { runtime, commitUrl } = runtimeOn("en");
    const change = createLocaleChanger(runtime);

    await change("ar");

    expect(commitUrl).toHaveBeenLastCalledWith("https://app.test/ar/about", "push");

    vi.stubGlobal("window", {
      location: { href: "https://app.test/ar/about", protocol: "https:", assign: vi.fn() },
      history: { pushState: browser.pushState, replaceState: browser.replaceState },
    });

    await change("en");

    expect(commitUrl).toHaveBeenLastCalledWith("https://app.test/about", "push");
    expect(browser.pushState).not.toHaveBeenCalled();
  });
});
