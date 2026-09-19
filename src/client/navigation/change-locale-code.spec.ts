import { stringify } from "devalue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { publishLocaleRouting } from "../../routing/locale-routing";
import { publishRouteTable, resetRouteTable } from "../../routing/route-table";
import { routerEvents } from "../../routing/router-events";
import {
  changeLocaleCode,
  connectLocaleChanger,
  createLocaleChanger,
  type LocaleChanger,
} from "./change-locale-code";
import type { RefreshRuntime, RefreshablePage } from "./refresh";

/**
 * `changeLocaleCode()` — switch the active locale without a full page reload.
 *
 * The server resolves a request's locale as the first present
 * of a `?locale=` query param, the `locale` cookie, then a `locale` header
 * (`core/src/http/request.ts:352-360`), the query param outranking the rest —
 * and there is no URL-prefix mode. So this sends `?locale=<code>` on the FETCH
 * URL only (never the visible one) and lets the server persist the choice
 * into its own cookie on that request. The client writes no cookie itself.
 */

const HREF = "https://app.test/products";

function payloadOf(
  name: string,
  locale: string,
  pageData: object = {},
): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData, shared: {}, name, locale, translations: {} };
}

function payloadResponse(payload: HydrationDocumentPayloadSource, url: string) {
  const headers = new Headers();

  headers.set("content-type", "application/json; charset=utf-8");

  return {
    ok: true,
    status: 200,
    headers,
    url,
    // devalue is the page-data wire format: `fetchPageData` reads `.text()`
    // and decodes it with devalue's `parse`, never `.json()`.
    text: async () => stringify(payload),
  };
}

/** Answer every request with the same payload, echoing back the request URL. */
function respondWith(payload: HydrationDocumentPayloadSource) {
  const fetchMock = vi.fn(async (url: string) => payloadResponse(payload, url));

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

type Browser = {
  replaceState: ReturnType<typeof vi.fn>;
  pushState: ReturnType<typeof vi.fn>;
  assign: ReturnType<typeof vi.fn>;
  /** `document.documentElement`, seeded `lang="en" dir="ltr"` — the state a
   * real full load in English leaves it in, the same seed
   * `navigation-root-document.spec.ts` uses. */
  documentElement: { lang: string; dir: string };
};

function stubBrowser(href = HREF): Browser {
  const documentElement = { lang: "en", dir: "ltr" };
  const browser: Browser = {
    replaceState: vi.fn(),
    pushState: vi.fn(),
    assign: vi.fn(),
    documentElement,
  };

  vi.stubGlobal("window", {
    location: { href, assign: browser.assign },
    history: { replaceState: browser.replaceState, pushState: browser.pushState },
  });
  // `syncDocumentLocale` reads/writes `document.documentElement` directly —
  // the environment is `"node"` (no real DOM), so this is the same kind of
  // bare stand-in `window` already gets above, just enough surface for
  // `syncDocumentLocale` to operate on.
  vi.stubGlobal("document", { documentElement });

  return browser;
}

type Harness = {
  runtime: RefreshRuntime;
  writes: RefreshablePage[];
  onScreen: () => RefreshablePage;
};

function harness(initial: RefreshablePage): Harness {
  let token = 0;
  let current = initial;
  const writes: RefreshablePage[] = [];

  return {
    runtime: {
      readCurrent: () => current,
      writeCurrent: (page) => {
        current = page;
        writes.push(page);
      },
      buildTree: async (payload) => `tree:${payload.name}:${payload.locale}`,
      claimTicket: () => {
        const ticket = ++token;

        return { isCurrent: () => ticket === token, signal: new AbortController().signal };
      },
    },
    writes,
    onScreen: () => current,
  };
}

function pageOf(payload: HydrationDocumentPayloadSource): RefreshablePage {
  return { payload, tree: `tree:${payload.name}:${payload.locale}`, routeSource: payload };
}

function listen() {
  const navigating: unknown[] = [];
  const navigated: unknown[] = [];
  const failed: unknown[] = [];

  const stops = [
    routerEvents.onNavigating((event) => navigating.push(event)),
    routerEvents.onNavigated((event) => navigated.push(event)),
    routerEvents.onNavigationError((event) => failed.push(event)),
  ];

  return { navigating, navigated, failed, stop: () => stops.forEach((stop) => stop()) };
}

let events: ReturnType<typeof listen>;
let changer: LocaleChanger;

beforeEach(() => {
  events = listen();
});

afterEach(() => {
  events.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  connectLocaleChanger(undefined);
  publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" });
});

describe("changeLocaleCode — the seam", () => {
  it("resolves without throwing when no runtime is connected", async () => {
    await expect(changeLocaleCode("ar")).resolves.toBeUndefined();
  });

  it("resolves without throwing when there is no window at all", async () => {
    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    connectLocaleChanger(createLocaleChanger(scenario.runtime));

    const fetchMock = respondWith(payloadOf("products.list", "ar"));

    expect(typeof window).toBe("undefined");
    await expect(changeLocaleCode("ar")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(scenario.writes).toHaveLength(0);
  });

  it("delegates to the connected runtime and hands back the previous one", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);

    expect(connectLocaleChanger(first)).toBeUndefined();
    await changeLocaleCode("ar");
    expect(first).toHaveBeenCalledWith("ar");

    expect(connectLocaleChanger(second)).toBe(first);
    await changeLocaleCode("fr");
    expect(second).toHaveBeenCalledWith("fr");
  });
});

describe("changeLocaleCode — the same locale is a no-op", () => {
  it("makes no request and writes nothing when code is already active", async () => {
    stubBrowser();
    const fetchMock = respondWith(payloadOf("products.list", "en"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("en");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(scenario.writes).toHaveLength(0);
    expect(events.navigating).toEqual([]);
  });
});

describe("changeLocaleCode — the happy path", () => {
  it("sends ?locale=<code> on the fetch URL only, keeping the rest of the query and hash", async () => {
    stubBrowser("https://app.test/products?page=2#reviews");
    const fetchMock = respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).toBe("https://app.test/products?page=2&locale=ar#reviews");
  });

  it("swaps in the fresh page so the rendered locale changes", async () => {
    const browser = stubBrowser();

    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(scenario.writes).toHaveLength(1);
    expect(scenario.onScreen().payload.locale).toBe("ar");
    expect(scenario.onScreen().tree).toBe("tree:products.list:ar");

    // The visible URL carried no `locale` param, so nothing to clean up.
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.assign).not.toHaveBeenCalled();
  });

  it("announces itself the same way a refresh does, so a progress bar sees it", async () => {
    stubBrowser();
    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(events.navigating).toEqual([{ url: HREF, mode: "replace" }]);
    expect(events.navigated).toEqual([{ url: HREF, resolvedUrl: HREF, mode: "replace" }]);
    expect(events.failed).toEqual([]);
  });

  it("does not make the fresh page its own previous route", async () => {
    stubBrowser();

    const onScreenBefore = pageOf(payloadOf("products.list", "en"));

    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(onScreenBefore);

    await createLocaleChanger(scenario.runtime)("ar");

    const [write] = scenario.writes;
    if (!write) throw new Error("expected changeLocaleCode to have written a page");

    expect(write.routeSource).toBe(onScreenBefore.routeSource);
    expect(write.payload).not.toBe(onScreenBefore.payload);
  });
});

describe("changeLocaleCode — the visible URL", () => {
  it("strips a `locale` query param already on the visible URL, keeping the rest", async () => {
    const browser = stubBrowser("https://app.test/products?locale=en&page=2#reviews");

    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(browser.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://app.test/products?page=2#reviews",
    );
    expect(browser.pushState).not.toHaveBeenCalled();
  });
});

describe("changeLocaleCode — a failure leaves the page and locale unchanged", () => {
  it.each([
    [
      "the network is gone",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new TypeError("offline");
          }),
        ),
    ],
    [
      "the server answers 500",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({
            ok: false,
            status: 500,
            headers: new Headers(),
            url: HREF,
            json: async () => ({}),
          })),
        ),
    ],
  ])("rejects and writes nothing when %s", async (_label, arrange) => {
    const browser = stubBrowser();

    arrange();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const onScreenBefore = pageOf(payloadOf("products.list", "en"));
    const scenario = harness(onScreenBefore);

    await expect(createLocaleChanger(scenario.runtime)("ar")).rejects.toThrow();

    expect(scenario.writes).toHaveLength(0);
    expect(scenario.onScreen()).toBe(onScreenBefore);
    expect(scenario.onScreen().payload.locale).toBe("en");
    expect(browser.assign).not.toHaveBeenCalled();
    expect(browser.replaceState).not.toHaveBeenCalled();

    expect(events.failed).toHaveLength(1);
    expect(events.navigated).toEqual([]);
  });

  it("rejects and writes nothing when the fresh tree cannot be built", async () => {
    const browser = stubBrowser();

    respondWith(payloadOf("products.list", "ar"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const onScreenBefore = pageOf(payloadOf("products.list", "en"));
    const scenario: Harness = {
      ...harness(onScreenBefore),
    };
    // Override buildTree to fail, keeping the rest of the harness intact.
    scenario.runtime.buildTree = async () => {
      throw new Error("chunk 404");
    };

    await expect(createLocaleChanger(scenario.runtime)("ar")).rejects.toThrow("chunk 404");

    expect(scenario.writes).toHaveLength(0);
    expect(scenario.onScreen()).toBe(onScreenBefore);
    expect(browser.assign).not.toHaveBeenCalled();
    expect(events.failed).toHaveLength(1);
  });
});

describe("changeLocaleCode — locale routing (design note §B.3)", () => {
  it("en→ar pushes the re-prefixed URL and fetches it directly, no ?locale=", async () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const browser = stubBrowser("https://app.test/products?page=2#reviews");
    const fetchMock = respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).toBe("https://app.test/ar/products?page=2#reviews");
    expect(browser.pushState).toHaveBeenCalledWith(
      null,
      "",
      "https://app.test/ar/products?page=2#reviews",
    );
    expect(browser.replaceState).not.toHaveBeenCalled();
  });

  it("ar→en under prefix-except-default produces the bare path", async () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const browser = stubBrowser("https://app.test/ar/products?page=2#reviews");
    const fetchMock = respondWith(payloadOf("products.list", "en"));

    const scenario = harness(pageOf(payloadOf("products.list", "ar")));

    await createLocaleChanger(scenario.runtime)("en");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).toBe("https://app.test/products?page=2#reviews");
    expect(browser.pushState).toHaveBeenCalledWith(
      null,
      "",
      "https://app.test/products?page=2#reviews",
    );
  });

  it("announces itself with mode push, so a progress bar sees a real navigation", async () => {
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    stubBrowser("https://app.test/en/products");
    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(events.navigating).toEqual([{ url: "https://app.test/en/products", mode: "push" }]);
    expect(events.navigated).toEqual([
      {
        url: "https://app.test/en/products",
        resolvedUrl: "https://app.test/ar/products",
        mode: "push",
      },
    ]);
  });

  it("swaps in the fresh page so the rendered locale changes", async () => {
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    stubBrowser("https://app.test/en/products");
    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(scenario.writes).toHaveLength(1);
    expect(scenario.onScreen().payload.locale).toBe("ar");
  });
});

describe("changeLocaleCode — documentElement lang/dir (root.tsx is outside the hydrated subtree)", () => {
  it("en→ar under prefix-except-default leaves documentElement lang=ar dir=rtl", async () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const browser = stubBrowser("https://app.test/products");
    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(browser.documentElement.lang).toBe("ar");
    expect(browser.documentElement.dir).toBe("rtl");
  });

  it("strategy none (the ?locale= path) still syncs documentElement — the innocent case", async () => {
    const browser = stubBrowser();

    respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    expect(browser.documentElement.lang).toBe("ar");
    expect(browser.documentElement.dir).toBe("rtl");
  });
});

describe("changeLocaleCode — [locale] folder routing (design note §C.3)", () => {
  afterEach(() => {
    resetRouteTable();
  });

  /** A payload whose matched route carries `:locale` as its first segment. */
  function localeParamPayloadOf(locale: string, params: Record<string, string>) {
    return { ...payloadOf("posts.show", locale), params };
  }

  it("en→ar pushes the same path with the first segment swapped, keeping query and hash", async () => {
    publishRouteTable([{ name: "posts.show", path: "/:locale/posts/:slug" }], "clc.spec");

    const browser = stubBrowser("https://app.test/en/posts/x?q=1#h");
    const fetchMock = respondWith(localeParamPayloadOf("ar", { locale: "ar", slug: "x" }));

    const scenario = harness(pageOf(localeParamPayloadOf("en", { locale: "en", slug: "x" })));

    await createLocaleChanger(scenario.runtime)("ar");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).toBe("https://app.test/ar/posts/x?q=1#h");
    expect(browser.pushState).toHaveBeenCalledWith(null, "", "https://app.test/ar/posts/x?q=1#h");
    expect(browser.replaceState).not.toHaveBeenCalled();
  });

  it("does not send ?locale= for a [locale]-routed page", async () => {
    publishRouteTable([{ name: "posts.show", path: "/:locale/posts/:slug" }], "clc.spec");

    stubBrowser("https://app.test/en/posts/x");
    const fetchMock = respondWith(localeParamPayloadOf("ar", { locale: "ar", slug: "x" }));

    const scenario = harness(pageOf(localeParamPayloadOf("en", { locale: "en", slug: "x" })));

    await createLocaleChanger(scenario.runtime)("ar");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).not.toContain("locale=");
  });

  it("does not treat the page as [locale]-routed when strategy none and no [locale] route is published", async () => {
    // No route table published at all — `routePathOf` answers `undefined`,
    // the same as a plain page under strategy `"none"`, the innocent case.
    const browser = stubBrowser("https://app.test/products?page=2#reviews");
    const fetchMock = respondWith(payloadOf("products.list", "ar"));

    const scenario = harness(pageOf(payloadOf("products.list", "en")));

    await createLocaleChanger(scenario.runtime)("ar");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).toBe("https://app.test/products?page=2&locale=ar#reviews");
    expect(browser.pushState).not.toHaveBeenCalled();
  });

  it("does not treat an ordinary param route named posts.show as [locale]-routed when its path has no leading :locale", async () => {
    publishRouteTable([{ name: "posts.show", path: "/posts/:slug" }], "clc.spec");

    const browser = stubBrowser("https://app.test/posts/x?page=2#reviews");
    const fetchMock = respondWith({ ...payloadOf("posts.show", "ar"), params: { slug: "x" } });

    const scenario = harness(pageOf({ ...payloadOf("posts.show", "en"), params: { slug: "x" } }));

    await createLocaleChanger(scenario.runtime)("ar");

    const [requestedUrl] = fetchMock.mock.calls[0] as [string];

    expect(requestedUrl).toBe("https://app.test/posts/x?page=2&locale=ar#reviews");
    expect(browser.pushState).not.toHaveBeenCalled();
  });
});
