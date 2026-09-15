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
   * identity and break `toBeInstanceOf`).
   */
  it("is idempotent and rejects every still-pending key with DeferredStreamClosedError on DOMContentLoaded, with no hard navigation", async () => {
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });

    const pageData: Record<string, unknown> = {};
    prepareDeferredPageData(pageData, ["reviews"]);

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
  });
});
