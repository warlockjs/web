import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { routerEvents } from "../../routing/router-events";
import {
  connectRefresher,
  createRefresher,
  refresh,
  type RefreshRuntime,
  type RefreshablePage,
} from "./refresh";

/**
 * `refresh()` — re-fetch the current route's data and re-render it.
 *
 * ## The assertion this file exists for
 *
 * A refresh that fails must leave the page EXACTLY as it was. Every other
 * behaviour here is a convenience; that one is the difference between "the
 * mutation's result did not appear" and "the user's screen went away on a
 * network blip". So the failure cases outnumber the happy one, and each of them
 * asserts the same three things: nothing was written, nothing was navigated,
 * and the error was announced rather than swallowed.
 *
 * ## Why the runtime is injected rather than mounted
 *
 * The suite runs in vitest's `node` environment (`web/vitest.config.ts`) and
 * this package has no DOM test dependency, so a React effect cannot be made to
 * run — `renderToStaticMarkup` never fires one. The refresh logic therefore
 * lives behind {@link createRefresher}, which takes the four things
 * `NavigationRoot` uniquely owns (the page on screen, the swap, the tree
 * builder, the race counter) and nothing else. That is what makes it provable
 * here, against the REAL `fetchPageData` over a stubbed `fetch`.
 */

const HREF = "https://app.test/products";

function payloadOf(name: string, pageData: object = {}): HydrationDocumentPayloadSource {
  return { appData: {}, layoutData: {}, pageData, shared: {}, name };
}

/** A response-like object shaped as `fetchPageData` reads it. */
function payloadResponse(payload: HydrationDocumentPayloadSource, url = HREF) {
  const headers = new Headers();

  headers.set("content-type", "application/json; charset=utf-8");

  return {
    ok: true,
    status: 200,
    headers,
    url,
    json: async () => payload,
  };
}

/** Answer every request with the same payload. */
function respondWith(payload: HydrationDocumentPayloadSource, url = HREF): void {
  vi.stubGlobal("fetch", vi.fn(async () => payloadResponse(payload, url)));
}

/** Answer each request from a queue, resolved by the test in whatever order it likes. */
function respondInOrder(payloads: HydrationDocumentPayloadSource[]) {
  const gates = payloads.map(() => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>(resolve => {
      open = resolve;
    });

    return { open, opened };
  });

  let call = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const index = call++;

      await gates[index].opened;

      return payloadResponse(payloads[index]);
    }),
  );

  return gates.map(gate => gate.open);
}

type Browser = {
  replaceState: ReturnType<typeof vi.fn>;
  pushState: ReturnType<typeof vi.fn>;
  assign: ReturnType<typeof vi.fn>;
};

function stubBrowser(href = HREF): Browser {
  const browser: Browser = { replaceState: vi.fn(), pushState: vi.fn(), assign: vi.fn() };

  vi.stubGlobal("window", {
    location: { href, assign: browser.assign },
    history: { replaceState: browser.replaceState, pushState: browser.pushState },
  });

  return browser;
}

type Harness = {
  runtime: RefreshRuntime;
  /** Every page the refresher swapped in, oldest first. */
  writes: RefreshablePage[];
  /** The page "on screen" right now. */
  onScreen: () => RefreshablePage;
  /** Simulate something newer taking a ticket from the same counter. */
  supersede: () => void;
};

function harness(
  initial: RefreshablePage,
  buildTree: (payload: HydrationDocumentPayloadSource) => Promise<string> = async payload =>
    `tree:${payload.name}`,
): Harness {
  let token = 0;
  let current = initial;
  const writes: RefreshablePage[] = [];

  return {
    runtime: {
      readCurrent: () => current,
      writeCurrent: page => {
        current = page;
        writes.push(page);
      },
      buildTree,
      claimTicket: () => {
        const ticket = ++token;

        return () => ticket === token;
      },
    },
    writes,
    onScreen: () => current,
    supersede: () => {
      token++;
    },
  };
}

function pageOf(payload: HydrationDocumentPayloadSource): RefreshablePage {
  return { payload, tree: `tree:${payload.name}`, routeSource: payload };
}

/** Collect every router event, and stop listening when the test ends. */
function listen() {
  const navigating: unknown[] = [];
  const navigated: unknown[] = [];
  const failed: unknown[] = [];

  const stops = [
    routerEvents.onNavigating(event => navigating.push(event)),
    routerEvents.onNavigated(event => navigated.push(event)),
    routerEvents.onNavigationError(event => failed.push(event)),
  ];

  return { navigating, navigated, failed, stop: () => stops.forEach(stop => stop()) };
}

let events: ReturnType<typeof listen>;

beforeEach(() => {
  events = listen();
});

afterEach(() => {
  events.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  connectRefresher(undefined);
});

describe("refresh — the seam", () => {
  /**
   * The `refresh()` verb is importable from a universal module, so it can be
   * called during the server render and in the gap before hydration connects
   * the runtime. Both answer `false`; neither throws. Same contract as
   * `navigateTo` (`verbs.ts`).
   */
  it("returns false without throwing when no runtime is connected", async () => {
    await expect(refresh()).resolves.toBe(false);
  });

  it("returns false without throwing when there is no window at all", async () => {
    const scenario = harness(pageOf(payloadOf("products.list")));

    connectRefresher(createRefresher(scenario.runtime));
    respondWith(payloadOf("products.list"));

    // `window` is genuinely absent in this suite's node environment — not
    // simulated — so this is the real server-render call.
    expect(typeof window).toBe("undefined");
    await expect(refresh()).resolves.toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(scenario.writes).toHaveLength(0);
  });

  it("delegates to the connected runtime and hands back the previous one", async () => {
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => false);

    expect(connectRefresher(first)).toBeUndefined();
    await expect(refresh()).resolves.toBe(true);
    expect(first).toHaveBeenCalledTimes(1);

    expect(connectRefresher(second)).toBe(first);
    await expect(refresh()).resolves.toBe(false);
  });
});

describe("refresh — the happy path", () => {
  it("re-fetches the URL on screen and swaps in the fresh page", async () => {
    stubBrowser();
    respondWith(payloadOf("products.list", { count: 7 }));

    const scenario = harness(pageOf(payloadOf("products.list", { count: 2 })));
    const refresher = createRefresher(scenario.runtime);

    await expect(refresher()).resolves.toBe(true);

    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];

    // The SAME data path a navigation uses — the `x-warlock-data` marker, not a
    // second endpoint.
    expect(url).toBe(HREF);
    expect((init.headers as Record<string, string>)["x-warlock-data"]).toBe("1");

    expect(scenario.writes).toHaveLength(1);
    expect(scenario.onScreen().payload.pageData).toEqual({ count: 7 });
    expect(scenario.onScreen().tree).toBe("tree:products.list");
  });

  /**
   * A refresh is not a move. Pushing here would make Back a no-op the user has
   * to press twice, and there is no new URL to record in the first place.
   */
  it("writes no history entry when the URL did not change", async () => {
    const browser = stubBrowser();

    respondWith(payloadOf("products.list"));

    await createRefresher(harness(pageOf(payloadOf("products.list"))).runtime)();

    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(browser.assign).not.toHaveBeenCalled();
  });

  it("announces itself as a navigation so a progress bar sees it", async () => {
    stubBrowser();
    respondWith(payloadOf("products.list"));

    await createRefresher(harness(pageOf(payloadOf("products.list"))).runtime)();

    expect(events.navigating).toEqual([{ url: HREF, mode: "replace" }]);
    expect(events.navigated).toEqual([{ url: HREF, resolvedUrl: HREF, mode: "replace" }]);
    expect(events.failed).toEqual([]);
  });
});

describe("refresh — a failure never costs the page", () => {
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
    [
      "a proxy answers HTML",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            const headers = new Headers();

            headers.set("content-type", "text/html");

            return { ok: true, status: 200, headers, url: HREF, json: async () => ({}) };
          }),
        ),
    ],
  ])("leaves the page intact and reports when %s", async (_label, arrange) => {
    const browser = stubBrowser();

    arrange();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const onScreenBefore = pageOf(payloadOf("products.list", { count: 2 }));
    const scenario = harness(onScreenBefore);

    await expect(createRefresher(scenario.runtime)()).resolves.toBe(false);

    // The three claims that matter, in the order they matter.
    expect(scenario.writes).toHaveLength(0);
    expect(scenario.onScreen()).toBe(onScreenBefore);
    expect(browser.assign).not.toHaveBeenCalled();

    expect(events.failed).toHaveLength(1);
    expect(events.failed[0]).toMatchObject({ url: HREF, mode: "replace" });
    expect((events.failed[0] as { error: unknown }).error).toBeDefined();
    expect(events.navigated).toEqual([]);
  });

  /**
   * The payload arrived but its page chunk would not load — a stale bundle
   * after a deploy. A NAVIGATION degrades to a full browser load here, because
   * the user still has to get to the new page. A refresh must not: the user is
   * already where they wanted to be, and reloading would throw away the form
   * they just submitted from.
   */
  it("leaves the page intact when the fresh tree cannot be built", async () => {
    const browser = stubBrowser();

    respondWith(payloadOf("products.list"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const onScreenBefore = pageOf(payloadOf("products.list"));
    const scenario = harness(onScreenBefore, async () => {
      throw new Error("chunk 404");
    });

    await expect(createRefresher(scenario.runtime)()).resolves.toBe(false);

    expect(scenario.writes).toHaveLength(0);
    expect(scenario.onScreen()).toBe(onScreenBefore);
    expect(browser.assign).not.toHaveBeenCalled();
    expect(events.failed).toHaveLength(1);
  });
});

describe("refresh — and previousRoute()", () => {
  /**
   * THE DECISION THIS CARD OWNS.
   *
   * `recordCurrentRoute` keys on payload OBJECT IDENTITY, and a refresh always
   * produces a new payload object for the page already on screen. Left alone,
   * refreshing `/products` would make `products.list` its own previous route —
   * so `previousRoute()` would answer with the page the user is looking at, and
   * a "back to where I came from" link would point at itself.
   *
   * So the refreshed page carries forward the ROUTE SOURCE of the page it
   * replaces. The payload on screen is the fresh one (the tree and the document
   * context must be current); the object `current-route` recognises the route by
   * is the old one, unchanged, so nothing shifts.
   */
  it("does not make the current page its own previous route", async () => {
    stubBrowser();

    const onScreenBefore = pageOf(payloadOf("products.list", { count: 2 }));

    respondWith(payloadOf("products.list", { count: 7 }));

    const scenario = harness(onScreenBefore);

    await createRefresher(scenario.runtime)();

    expect(scenario.writes[0].routeSource).toBe(onScreenBefore.routeSource);
    // ...while the page itself IS the fresh one.
    expect(scenario.writes[0].payload).not.toBe(onScreenBefore.payload);
  });

  /** The same claim, proven through `current-route` rather than by inspection. */
  it("leaves previousRoute() untouched across a refresh", async () => {
    stubBrowser();
    vi.resetModules();

    const { recordCurrentRoute, currentRoute, previousRoute } = await import("./current-route");
    const { createRefresher: create } = await import("./refresh");

    const landed = payloadOf("products.list", { count: 2 });
    const scenario = harness(pageOf(landed));

    recordCurrentRoute(landed);
    respondWith(payloadOf("products.list", { count: 7 }));

    await create(scenario.runtime)();

    // What `NavigationRoot` does on the render that follows the swap.
    recordCurrentRoute(scenario.onScreen().routeSource);

    expect(currentRoute()).toEqual({ name: "products.list" });
    expect(previousRoute()).toBeUndefined();
  });

  /**
   * The exception, and it is not a special case so much as the same rule read
   * honestly: if the re-fetch came back as a DIFFERENT entry, the server moved
   * the user — a session expiring into `/login` is the ordinary cause. The page
   * on screen really did change, so `currentRoute()` must change with it, and
   * carrying the old source forward would make it lie.
   */
  it("records a real move when the server answers with a different route", async () => {
    const browser = stubBrowser();
    const redirected = payloadOf("auth.login");

    respondWith(redirected, "https://app.test/login");

    const onScreenBefore = pageOf(payloadOf("products.list"));
    const scenario = harness(onScreenBefore);

    await expect(createRefresher(scenario.runtime)()).resolves.toBe(true);

    expect(scenario.writes[0].routeSource).toBe(scenario.writes[0].payload);
    expect(scenario.writes[0].routeSource).not.toBe(onScreenBefore.routeSource);
    // The address bar has to follow the page, and REPLACE — a refresh never
    // pushes.
    expect(browser.replaceState).toHaveBeenCalledWith(null, "", "https://app.test/login");
    expect(browser.pushState).not.toHaveBeenCalled();
  });

  /**
   * A redirect that stayed within one route entry — `?page=2` collapsing to
   * `?page=1` because the last row was just deleted. The address bar follows,
   * because it names the URL on screen; the route did not move, because it is
   * the same entry, so `previousRoute()` still must not shift.
   */
  it("follows a redirect in the address bar without moving the route", async () => {
    const browser = stubBrowser();
    const onScreenBefore = pageOf(payloadOf("products.list", { page: 2 }));

    respondWith(payloadOf("products.list", { page: 1 }), "https://app.test/products?page=1");

    const scenario = harness(onScreenBefore);

    await expect(createRefresher(scenario.runtime)()).resolves.toBe(true);

    expect(browser.replaceState).toHaveBeenCalledWith(null, "", "https://app.test/products?page=1");
    expect(browser.pushState).not.toHaveBeenCalled();
    expect(scenario.writes[0].routeSource).toBe(onScreenBefore.routeSource);
  });
});

describe("refresh — races", () => {
  /**
   * Two refreshes in flight, the first answering last. Without a shared ticket
   * the stale body lands on top of the fresh one and the user sees data older
   * than the mutation they just made.
   */
  it("drops a response that a newer refresh has already superseded", async () => {
    stubBrowser();

    const [openFirst, openSecond] = respondInOrder([
      payloadOf("products.list", { count: 2 }),
      payloadOf("products.list", { count: 7 }),
    ]);

    const scenario = harness(pageOf(payloadOf("products.list", { count: 0 })));
    const refresher = createRefresher(scenario.runtime);

    const first = refresher();
    const second = refresher();

    openSecond();
    await expect(second).resolves.toBe(true);

    openFirst();
    await expect(first).resolves.toBe(false);

    expect(scenario.writes).toHaveLength(1);
    expect(scenario.onScreen().payload.pageData).toEqual({ count: 7 });
    // Superseded is not failed: the answer to a question nobody is asking any
    // more is not an error to show anyone.
    expect(events.failed).toEqual([]);
  });

  /**
   * A navigation started while a refresh was in flight. The refresh takes its
   * ticket from the SAME counter `NavigationRoot` uses for navigations, which
   * is the only reason this can be detected at all.
   */
  it("drops a refresh that a navigation has overtaken", async () => {
    stubBrowser();

    const [open] = respondInOrder([payloadOf("products.list", { count: 7 })]);
    const onScreenBefore = pageOf(payloadOf("products.list", { count: 2 }));
    const scenario = harness(onScreenBefore);

    const pending = createRefresher(scenario.runtime)();

    scenario.supersede();
    open();

    await expect(pending).resolves.toBe(false);
    expect(scenario.writes).toHaveLength(0);
    expect(scenario.onScreen()).toBe(onScreenBefore);
  });
});
