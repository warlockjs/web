// @vitest-environment jsdom
import { act, createElement, use, Suspense, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { stringify } from "devalue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredStreamClosedError } from "./deferred-stream-closed-error";
import { DeferredValueError } from "./deferred-value-error";
import {
  DEFER_BOOTSTRAP_SOURCE,
  installStreamClosedRejection,
  prepareDeferredPageData,
  rejectPendingDeferredKeys,
  releaseDeferredScope,
  settleDeferredValue,
  type DeferredSettlement,
} from "./defer-registry";

/** Required by React 19's `act()` to recognize this as a testing environment. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type WarlockWindow = typeof globalThis & {
  __WARLOCK_DEFER__?: (key: string, raw: string) => void;
  __WARLOCK_DEFERRED__?: Record<string, unknown>;
};

/** Runs the exact bootstrap source, the same way an inline `<script>` would. */
function runBootstrap(): void {
  // eslint-disable-next-line no-new-func -- exercising the literal inline-script source.
  new Function(DEFER_BOOTSTRAP_SOURCE)();
}

function warlockWindow(): WarlockWindow {
  return window as WarlockWindow;
}

/**
 * Calls `window.__WARLOCK_DEFER__` exactly the way a real chunk script does:
 * the settlement devalue-serialized to a string first — never the live
 * object — because that argument is what the wire actually carries
 * (`defer-emission.ts`'s `deferCallScript`).
 */
function callDefer(key: string, settlement: DeferredSettlement): void {
  const fn = warlockWindow().__WARLOCK_DEFER__;

  if (fn === undefined) throw new Error("__WARLOCK_DEFER__ was not installed by the bootstrap.");

  fn(key, stringify(settlement));
}

beforeEach(() => {
  runBootstrap();
});

afterEach(() => {
  delete warlockWindow().__WARLOCK_DEFER__;
  delete warlockWindow().__WARLOCK_DEFERRED__;
  vi.restoreAllMocks();
});

describe("defer-registry — chunk ordering", () => {
  it("resolves with the value for a chunk that arrives AFTER prepare", async () => {
    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"]);

    callDefer("reviews", { ok: true, value: { count: 3 } });

    await expect(pageData.reviews).resolves.toEqual({ count: 3 });
  });

  it("is already settled for a chunk that arrives BEFORE prepare (early chunk)", async () => {
    callDefer("reviews", { ok: true, value: { count: 7 } });

    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"]);

    await expect(pageData.reviews).resolves.toEqual({ count: 7 });
  });
});

/** Minimal error boundary: reports the caught error to `onError`, then renders its message. */
class TestErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { error: unknown }
> {
  public state: { error: unknown } = { error: undefined };

  public static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  public componentDidUpdate(): void {
    if (this.state.error !== undefined) this.props.onError(this.state.error);
  }

  public render(): ReactNode {
    if (this.state.error !== undefined) {
      const error = this.state.error as { message: string };

      return createElement("p", null, error.message);
    }

    return this.props.children;
  }
}

function Reader({ promise }: { promise: Promise<unknown> }): ReactNode {
  const value = use(promise);

  return createElement("p", null, JSON.stringify(value));
}

describe("defer-registry — Suspense + error boundary rendering", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  it("renders the boundary with a DeferredValueError carrying message and statusCode", async () => {
    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"]);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const caught: unknown[] = [];

    // Awaited: the initial render immediately suspends (Reader's `use()` sees
    // a pending promise), and React only settles that Suspense boundary
    // properly if the act() call that triggers it is itself awaited.
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(TestErrorBoundary, {
          onError: (error) => {
            caught.push(error);
          },
          children: createElement(
            Suspense,
            { fallback: createElement("p", null, "loading") },
            createElement(Reader, { promise: pageData.reviews as Promise<unknown> }),
          ),
        }),
      );
    });

    expect(container.textContent).toBe("loading");

    await act(async () => {
      callDefer("reviews", {
        ok: false,
        error: { name: "ReviewsFetchError", message: "reviews service is down", statusCode: 503 },
      });
    });

    expect(container.textContent).toBe("reviews service is down");
    expect(caught[0]).toBeInstanceOf(DeferredValueError);
    expect(caught[0]).toMatchObject({ message: "reviews service is down", statusCode: 503 });
    consoleError.mockRestore();
  });
});

describe("defer-registry — installStreamClosedRejection", () => {
  /**
   * `installStreamClosedRejection`'s "installed" flag is deliberately
   * module-level, page-scoped state (Stage 2 contract rule 8 only needs one
   * listener per page load) — so this single test exercises idempotency AND
   * the rejection itself together, rather than resetting modules between
   * tests (which would create a second `DeferredStreamClosedError` class
   * identity and break `toBeInstanceOf`). The same constraint is why the
   * scope-isolation assertion below lives in THIS test rather than a second
   * one: a second call to `installStreamClosedRejection` anywhere else in
   * this file is a guaranteed no-op once the flag is set here.
   */
  it("is idempotent, rejects every still-pending key with DeferredStreamClosedError on DOMContentLoaded, with no hard navigation, and never touches a navigation scope's own pending key", async () => {
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });

    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"]);

    // A concurrent client navigation's own scope, still in flight — e.g. a
    // prefetch — must not be swept up by the DOCUMENT scope's stream-closed
    // rejection below.
    const navPageData: Record<string, unknown> = {};
    prepareDeferredPageData(navPageData, ["reviews"], "navigation:doc-isolation");

    const addEventListener = vi.spyOn(document, "addEventListener");

    installStreamClosedRejection();
    const callsAfterFirst = addEventListener.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    installStreamClosedRejection();
    expect(addEventListener.mock.calls.length).toBe(callsAfterFirst);

    const rejection = expect(pageData.reviews).rejects.toBeInstanceOf(DeferredStreamClosedError);

    document.dispatchEvent(new Event("DOMContentLoaded"));

    await rejection;
    await expect(pageData.reviews).rejects.toMatchObject({ key: "reviews" });

    let navSettled = false;
    void (navPageData.reviews as Promise<unknown>).then(
      () => {
        navSettled = true;
      },
      () => {
        navSettled = true;
      },
    );
    await Promise.resolve();
    expect(navSettled).toBe(false);

    settleDeferredValue("reviews", { ok: true, value: { count: 1 } }, "navigation:doc-isolation");
    await expect(navPageData.reviews).resolves.toEqual({ count: 1 });
  });
});

describe("defer-registry — rejectPendingDeferredKeys scoping", () => {
  it("rejecting one scope's keys never settles another scope's same-named pending key", async () => {
    const pageDataA: Record<string, unknown> = {};
    prepareDeferredPageData(pageDataA, ["reviews"], "navigation:1");

    const pageDataB: Record<string, unknown> = {};
    prepareDeferredPageData(pageDataB, ["reviews"], "navigation:2");

    rejectPendingDeferredKeys(["reviews"], "navigation:1");

    await expect(pageDataA.reviews).rejects.toBeInstanceOf(DeferredStreamClosedError);

    let bSettled = false;
    void (pageDataB.reviews as Promise<unknown>).then(
      () => {
        bSettled = true;
      },
      () => {
        bSettled = true;
      },
    );
    await Promise.resolve();
    expect(bSettled).toBe(false);

    settleDeferredValue("reviews", { ok: true, value: { count: 5 } }, "navigation:2");
    await expect(pageDataB.reviews).resolves.toEqual({ count: 5 });
  });
});

describe("defer-registry — rejected settlement scoping", () => {
  it("a rejected settlement in one scope never settles another scope's same-named key", async () => {
    const pageDataA: Record<string, unknown> = {};
    prepareDeferredPageData(pageDataA, ["reviews"], "navigation:1");

    const pageDataB: Record<string, unknown> = {};
    prepareDeferredPageData(pageDataB, ["reviews"], "navigation:2");

    settleDeferredValue(
      "reviews",
      { ok: false, error: { name: "ReviewsFetchError", message: "reviews service is down" } },
      "navigation:1",
    );

    await expect(pageDataA.reviews).rejects.toMatchObject({
      message: "reviews service is down",
    });

    let bSettled = false;
    void (pageDataB.reviews as Promise<unknown>).then(
      () => {
        bSettled = true;
      },
      () => {
        bSettled = true;
      },
    );
    await Promise.resolve();
    expect(bSettled).toBe(false);

    settleDeferredValue("reviews", { ok: true, value: { count: 9 } }, "navigation:2");
    await expect(pageDataB.reviews).resolves.toEqual({ count: 9 });
  });
});

describe("defer-registry — releaseDeferredScope", () => {
  it("deletes a settled entry belonging to the released scope", () => {
    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"], "navigation:1");
    settleDeferredValue("reviews", { ok: true, value: { count: 1 } }, "navigation:1");

    const beforeSize = Object.keys(warlockWindow().__WARLOCK_DEFERRED__ ?? {}).length;

    releaseDeferredScope("navigation:1");

    const afterSize = Object.keys(warlockWindow().__WARLOCK_DEFERRED__ ?? {}).length;
    expect(afterSize).toBe(beforeSize - 1);
  });

  it("leaves a still-pending entry of the released scope alone", async () => {
    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"], "navigation:1");

    const beforeSize = Object.keys(warlockWindow().__WARLOCK_DEFERRED__ ?? {}).length;

    releaseDeferredScope("navigation:1");

    const afterSize = Object.keys(warlockWindow().__WARLOCK_DEFERRED__ ?? {}).length;
    expect(afterSize).toBe(beforeSize);

    settleDeferredValue("reviews", { ok: true, value: { count: 2 } }, "navigation:1");
    await expect(pageData.reviews).resolves.toEqual({ count: 2 });
  });

  it("never touches another scope's entries, document scope included", async () => {
    const documentPageData: Record<string, unknown> = {};
    prepareDeferredPageData(documentPageData, ["reviews"]);
    settleDeferredValue("reviews", { ok: true, value: { count: 3 } });

    const navPageData: Record<string, unknown> = {};
    prepareDeferredPageData(navPageData, ["reviews"], "navigation:1");
    settleDeferredValue("reviews", { ok: true, value: { count: 4 } }, "navigation:1");

    releaseDeferredScope("navigation:1");

    // The document scope's own settled entry survives a navigation scope's
    // release — only the released scope's entries are removed.
    await expect(documentPageData.reviews).resolves.toEqual({ count: 3 });
  });
});
