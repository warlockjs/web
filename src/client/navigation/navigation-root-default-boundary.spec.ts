// @vitest-environment jsdom
import {
  act,
  Component,
  createElement,
  use,
  useEffect,
  type ComponentType,
  type ReactNode,
} from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HydrationDocumentPayloadSource,
  SerializedErrorPageProps,
} from "../../hydration-payload";
import { currentNavigator } from "../../routing/navigator";
import type { ClientPageEntry } from "../runtime";
import { NavigationRoot } from "./navigation-root";
import { refresh } from "./refresh";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

/**
 * The floor under test: a component that reads a rejected `defer()` value
 * with `use()` and no app-authored ErrorBoundary anywhere above it. This is
 * exactly the shape `prepareDeferredPageData` (`defer-registry.ts`) hands a
 * page — a promise that rejects with a {@link DeferredValueError} once the
 * server's settlement arrives — reproduced directly here so the test needs
 * no server round trip to prove the client-side gap.
 *
 * ## The second half of this file: the boundary must also let go
 *
 * Card `1afb563d`. `DefaultErrorBoundary` used to be keyed on the page
 * name (`key={current.payload.name}`), which never cleared a caught error
 * for a same-name swap — `/posts/1` -> `/posts/2`, or a plain `refresh()`
 * of the page already on screen — because the key never changed. The
 * fallback would sit there forever even once the new tree was healthy. The
 * tests below drive `NavigationRoot` through a real navigation/refresh with
 * a stubbed `fetch`, exactly as `navigation-root-abort.spec.ts` does, so the
 * claim is proven against the real navigator/refresher, not a mock of them.
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

function ThrowsOnRejectedDefer({ rejected }: { rejected: Promise<unknown> }): ReactNode {
  return createElement("div", { "data-testid": "page" }, use(rejected) as ReactNode);
}

/** A deferred value that simply resolves — Suspense's ordinary, unremarkable path. */
function RendersResolvedDefer({ resolved }: { resolved: Promise<string> }): ReactNode {
  return createElement("div", { "data-testid": "page" }, use(resolved));
}

/**
 * A single-route registry entry whose composition carries `ErrorPage` —
 * the same shape `loadClientRouteComposition` (`client/runtime/manifest.ts`)
 * validates, built by hand so this suite needs no bundler or discovery run.
 */
function errorPageEntry(
  name: string,
  ErrorPage: ComponentType<SerializedErrorPageProps>,
): ClientPageEntry {
  return {
    type: "page",
    name,
    path: `/${name}`,
    load: async () => ({
      Page: { default: () => null },
      layouts: [],
      ErrorPage: { default: ErrorPage },
    }),
  };
}

/**
 * Answers every fetch (navigation or refresh) with the same payload, as if
 * answered from `path` — resolved against the document's own origin, the
 * same way `navigation-root-abort.spec.ts`'s stub does, so a pushState of
 * the "response" URL never trips jsdom's same-origin check.
 */
function stubFetch(payload: HydrationDocumentPayloadSource, path: string): void {
  const url = new URL(path, window.location.href).href;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const headers = new Headers();

      headers.set("content-type", "application/json; charset=utf-8");

      return { ok: true, status: 200, headers, url, text: async () => stringify(payload) };
    }),
  );
}

/** Wait for the microtasks a navigation's/refresh's fetch + tree build need to settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * A layout wrapping the page, counting how many times it MOUNTS (empty
 * dependency array) rather than how many times it renders — a healthy swap
 * must reconcile it, not remount it.
 */
let layoutMounts = 0;

function CountingLayout({ children }: { children: ReactNode }): ReactNode {
  useEffect(() => {
    layoutMounts += 1;
  }, []);

  return createElement("div", { "data-testid": "layout" }, children);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
  window.history.replaceState(null, "", "/a");
  layoutMounts = 0;

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

describe("NavigationRoot — first-party failure floor for a rejected defer() value", () => {
  it("renders a visible fallback instead of leaving the tree blank when no app boundary exists", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const rejected = Promise.reject(new Error("loader boom"));
    rejected.catch(() => undefined);

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("page.a"),
          initialTree: createElement(ThrowsOnRejectedDefer, { rejected }),
          buildTree: async () => createElement(ThrowsOnRejectedDefer, { rejected }),
        }),
      );
      // Let the rejected promise settle so `use()` throws on the next pass.
      await rejected.catch(() => undefined);
    });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toBe("");
  });

  it("reports the failure unconditionally through the client error floor", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const rejected = Promise.reject(new Error("loader boom"));
    rejected.catch(() => undefined);

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("page.a"),
          initialTree: createElement(ThrowsOnRejectedDefer, { rejected }),
          buildTree: async () => createElement(ThrowsOnRejectedDefer, { rejected }),
        }),
      );
      await rejected.catch(() => undefined);
    });

    const reported = consoleError.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("[warlock:web]"),
    );

    expect(reported).toBe(true);
  });

  /**
   * Card `f087368c`, revised. The floor's fixed message is a FALLBACK, not
   * the whole contract — it is what renders when the current route has no
   * `error.page.tsx` to prefer (`pages: []` here means the route name can
   * never resolve to a registry entry). The next `describe` block below
   * covers the case where one IS configured.
   */
  it("renders the floor's own fixed fallback text when the current route has no configured error page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const rejected = Promise.reject(new Error("loader boom"));
    rejected.catch(() => undefined);

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("page.a"),
          initialTree: createElement(ThrowsOnRejectedDefer, { rejected }),
          buildTree: async () => createElement(ThrowsOnRejectedDefer, { rejected }),
        }),
      );
      await rejected.catch(() => undefined);
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Something went wrong.");
  });

  /**
   * The ordinary, unremarkable Suspense path — a deferred value that simply
   * RESOLVES. Nothing in this card changes it: no boundary catches, no
   * fallback of any kind renders, and the floor's report line never fires.
   */
  it("renders the resolved content with no boundary involvement when a deferred value simply resolves", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const resolved = Promise.resolve("reviews loaded");

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("page.a"),
          initialTree: createElement(RendersResolvedDefer, { resolved }),
          buildTree: async () => createElement(RendersResolvedDefer, { resolved }),
        }),
      );
      await resolved;
    });
    await flush();

    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe("reviews loaded");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    const floorReports = consoleError.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("an uncaught error reached the default client boundary"),
    );

    expect(floorReports).toHaveLength(0);
  });
});

/**
 * Card `f087368c`, revised per lead ruling: the floor PREFERS the current
 * route's app-owned `error.page.tsx` — resolved from the same page registry
 * `build-hydrated-tree.ts` resolves it from (`navigation-root.tsx`'s
 * `resolveErrorPageComponent`) — over its own fixed fallback, passing it a
 * freshly sanitized `SerializedErrorPageProps`. The fixed fallback remains
 * the fallback for "no error page" and for "the error page itself failed".
 */
describe("NavigationRoot — the default floor prefers the app's configured error page (card f087368c)", () => {
  afterEach(() => {
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = false;
  });

  it("renders the app's error page with a sanitized error shape once resolution has had a chance to settle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // @ts-expect-error test-only mutation of Vite's injected env object
    import.meta.env.DEV = true;

    let received: SerializedErrorPageProps | undefined;

    function AppErrorPage(props: SerializedErrorPageProps): ReactNode {
      received = props;

      return createElement("p", { "data-testid": "app-error-page" }, props.error.message);
    }

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [errorPageEntry("page.a", AppErrorPage)],
          initialPayload: payloadOf("page.a"),
          initialTree: healthyTree("page.a"),
          buildTree: async (_pages, payload) =>
            (payload.pageData as { broken?: boolean }).broken
              ? brokenTree()
              : healthyTree(payload.name),
        }),
      );
    });
    // Let the error page's own resolution (a dynamic import in production,
    // an async `load()` here) settle before the route fails — exactly the
    // ordering a real failure that happens well after mount, e.g. a rejected
    // `defer()` value, always has in practice.
    await flush();

    stubFetch({ ...payloadOf("page.a"), pageData: { broken: true } }, "/a?fail=1");

    act(() => {
      currentNavigator()?.("/a?fail=1");
    });
    await flush();

    const appErrorPage = container.querySelector('[data-testid="app-error-page"]');

    expect(appErrorPage?.textContent).toBe("boom");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(received?.status).toBe(500);
    expect(received?.error.name).toBe("Error");
  });

  it("falls back to the floor's own fixed fallback, reported once, when the app's error page itself throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowingAppErrorPage(): ReactNode {
      throw new Error("error.page.tsx itself is broken");
    }

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [errorPageEntry("page.a", ThrowingAppErrorPage)],
          initialPayload: payloadOf("page.a"),
          initialTree: healthyTree("page.a"),
          buildTree: async (_pages, payload) =>
            (payload.pageData as { broken?: boolean }).broken
              ? brokenTree()
              : healthyTree(payload.name),
        }),
      );
    });
    await flush();

    stubFetch({ ...payloadOf("page.a"), pageData: { broken: true } }, "/a?fail=1");

    act(() => {
      currentNavigator()?.("/a?fail=1");
    });
    await flush();

    const alert = container.querySelector('[role="alert"]');

    expect(alert?.textContent).toBe("Something went wrong.");

    const floorReports = consoleError.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("an uncaught error reached the default client boundary"),
    );

    expect(floorReports).toHaveLength(1);
  });
});

/**
 * Card `f087368c`. The floor sits at the TOP of the hydrated tree
 * (`navigation-root.tsx`), so an app-authored `ErrorBoundary` any level
 * BELOW it is the nearer boundary and React walks up to that one first —
 * the floor never renders and never runs `componentDidCatch` for a failure
 * that one already stopped.
 */
class AppErrorBoundary extends Component<
  { children: ReactNode; fallbackText: string },
  { error: unknown }
> {
  public state: { error: unknown } = { error: undefined };

  public static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  public render(): ReactNode {
    if (this.state.error !== undefined) {
      return createElement(
        "p",
        { "data-testid": "app-boundary-fallback" },
        this.props.fallbackText,
      );
    }

    return this.props.children;
  }
}

function ThrowsOnRejectedDeferBehindAppBoundary({
  rejected,
}: {
  rejected: Promise<unknown>;
}): ReactNode {
  return createElement(AppErrorBoundary, {
    fallbackText: "reviews unavailable",
    children: createElement(ThrowsOnRejectedDefer, { rejected }),
  });
}

describe("NavigationRoot — an app-authored ErrorBoundary nearer the failure wins over the default floor (card f087368c)", () => {
  it("renders the app boundary's own fallback, not the default floor's, when one wraps the failing component", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const rejected = Promise.reject(new Error("loader boom"));
    rejected.catch(() => undefined);

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("page.a"),
          initialTree: createElement(ThrowsOnRejectedDeferBehindAppBoundary, { rejected }),
          buildTree: async () =>
            createElement(ThrowsOnRejectedDeferBehindAppBoundary, { rejected }),
        }),
      );
      await rejected.catch(() => undefined);
    });

    expect(container.querySelector('[data-testid="app-boundary-fallback"]')?.textContent).toBe(
      "reviews unavailable",
    );
    // The default floor's own fallback text must not appear alongside it —
    // React stopped walking up once the app boundary caught, so the floor's
    // render() (still "Something went wrong.") never ran at all.
    expect(container.textContent).not.toContain("Something went wrong.");
  });

  it("reports the failure exactly once — not once from the app boundary and again from the floor", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const rejected = Promise.reject(new Error("loader boom"));
    rejected.catch(() => undefined);

    await act(async () => {
      root.render(
        createElement(NavigationRoot, {
          pages: [],
          initialPayload: payloadOf("page.a"),
          initialTree: createElement(ThrowsOnRejectedDeferBehindAppBoundary, { rejected }),
          buildTree: async () =>
            createElement(ThrowsOnRejectedDeferBehindAppBoundary, { rejected }),
        }),
      );
      await rejected.catch(() => undefined);
    });

    // `AppErrorBoundary` above deliberately reports nothing itself: the count
    // below is entirely attributable to whichever boundary(ies) called
    // `reportClientError` — an app boundary that catches the failure is not
    // obligated to report it, but the default floor's own unconditional
    // report (see `default-error-boundary.tsx`) must not ALSO fire once the
    // app boundary already stopped the error from reaching it.
    const floorReports = consoleError.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("an uncaught error reached the default client boundary"),
    );

    expect(floorReports).toHaveLength(0);
  });
});

/** Always throws during render — the page half of every scenario below. */
function ThrowsAlways(): ReactNode {
  throw new Error("boom");
}

/** A healthy page, wrapped in the same layout position as {@link ThrowsAlways}. */
function healthyTree(name: string): ReactNode {
  return createElement(CountingLayout, {
    children: createElement("div", { "data-testid": "page" }, name),
  });
}

function brokenTree(): ReactNode {
  return createElement(CountingLayout, { children: createElement(ThrowsAlways) });
}

async function mountBroken(name: string): Promise<void> {
  vi.spyOn(console, "error").mockImplementation(() => {});

  await act(async () => {
    root.render(
      createElement(NavigationRoot, {
        pages: [],
        initialPayload: payloadOf(name),
        initialTree: brokenTree(),
        buildTree: async (_pages, payload) =>
          (payload.pageData as { healthy?: boolean }).healthy
            ? healthyTree(payload.name)
            : brokenTree(),
      }),
    );
  });
}

function pageText(): string | null | undefined {
  return container.querySelector('[data-testid="page"]')?.textContent;
}

function fallbackShown(): boolean {
  return container.querySelector('[role="alert"]') !== null;
}

describe("NavigationRoot — the default boundary lets go on the next swap (card 1afb563d)", () => {
  it("recovers on a navigation to the SAME page name once the new payload is healthy", async () => {
    await mountBroken("page.a");
    expect(fallbackShown()).toBe(true);

    stubFetch({ ...payloadOf("page.a"), pageData: { healthy: true } }, "/a?again=1");

    act(() => {
      currentNavigator()?.("/a?again=1");
    });
    await flush();

    expect(fallbackShown()).toBe(false);
    expect(pageText()).toBe("page.a");
  });

  it("recovers after refresh() following an error", async () => {
    await mountBroken("page.a");
    expect(fallbackShown()).toBe(true);

    stubFetch({ ...payloadOf("page.a"), pageData: { healthy: true } }, "/a");

    await act(async () => {
      await refresh();
    });
    await flush();

    expect(fallbackShown()).toBe(false);
    expect(pageText()).toBe("page.a");
  });

  it("still recovers on a navigation to a DIFFERENT page name", async () => {
    await mountBroken("page.a");
    expect(fallbackShown()).toBe(true);

    stubFetch({ ...payloadOf("page.b"), pageData: { healthy: true } }, "/b");

    act(() => {
      currentNavigator()?.("/b");
    });
    await flush();

    expect(fallbackShown()).toBe(false);
    expect(pageText()).toBe("page.b");
  });

  it("does not remount layouts on a healthy same-name swap", async () => {
    // The layout only actually mounts once its tree first commits — the
    // broken initial render never does (the boundary discards it and
    // commits the fallback instead) — so the baseline is set by the FIRST
    // healthy swap, and the assertion is about the swap after it.
    await mountBroken("page.a");

    stubFetch({ ...payloadOf("page.a"), pageData: { healthy: true } }, "/a?first=1");

    act(() => {
      currentNavigator()?.("/a?first=1");
    });
    await flush();

    expect(pageText()).toBe("page.a");
    expect(layoutMounts).toBe(1);

    stubFetch({ ...payloadOf("page.a"), pageData: { healthy: true } }, "/a?second=1");

    act(() => {
      currentNavigator()?.("/a?second=1");
    });
    await flush();

    expect(pageText()).toBe("page.a");
    // Reconciled, not remounted: the layout is the same type in the same
    // position both before and after this second, healthy-to-healthy swap.
    expect(layoutMounts).toBe(1);
  });
});
