import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectSharedStore,
  enterSharedScope,
  hydrateShared,
  SharedClientWriteError,
  shared,
  useShared,
} from "../../src/shared";
import { makeStore, TestRequestContext } from "./test-request-context";

/**
 * `shared` on the client is a dead snapshot: writing to it cannot reach the
 * server and does not survive the next `hydrateShared()` call (a navigation
 * or refresh). These specs are the red control for that freeze: a server
 * write still works (1), a client write throws loudly and names the
 * replacement (2), and — with the freeze's guard bypassed the way a
 * misguided "wire the client to the ALS store too" fix would — a client
 * write is observed to be silently accepted and then lost across the next
 * hydration (3).
 */
describe("shared — frozen on the client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("(1) a server-side write during a request still succeeds", async () => {
    const context = new TestRequestContext();
    connectSharedStore(() => context.getStore());
    const store = makeStore();

    await context.run(store, async () => {
      enterSharedScope(store);
      (shared as Record<string, any>).locale = "en";
      expect((shared as Record<string, any>).locale).toBe("en");
    });
  });

  it("(2) a client write throws SharedClientWriteError with the full message", () => {
    hydrateShared({ locale: "en" });
    vi.stubGlobal("window", {});

    let caught: unknown;

    try {
      (shared as Record<string, any>).locale = "fr";
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SharedClientWriteError);
    expect((caught as Error).message).toMatch(/`shared`/);
    expect((caught as Error).message).toMatch(/dead snapshot/);
    expect((caught as Error).message).toMatch(/does not survive a `Link` navigation/);
    expect((caught as Error).message).toMatch(/declared props/);
    expect((caught as Error).message).toMatch(/useShared\(\)/);

    // reads, delete and define are writes-in-disguise on the client too
    expect(() => delete (shared as Record<string, any>).locale).toThrowError(
      SharedClientWriteError,
    );
    expect(() => Object.defineProperty(shared, "locale", { value: "fr" })).toThrowError(
      SharedClientWriteError,
    );
  });

  it("(3) with the guard bypassed, a client write is silently accepted then lost across navigation", async () => {
    // Reproduces what the client write would do WITHOUT the `typeof window`
    // guard added to the `set` trap: a raw write straight onto the
    // per-request target `enterSharedScope` hands back — the exact storage
    // the proxy's `set` trap would mutate if the guard were removed.
    const context = new TestRequestContext();
    connectSharedStore(() => context.getStore());
    const store = makeStore();

    let leakedTarget: Record<string, any> | undefined;

    await context.run(store, () => {
      leakedTarget = enterSharedScope(store) as Record<string, any>;
    });

    hydrateShared({ locale: "en" });
    vi.stubGlobal("window", {});

    // The unguarded write: appears to succeed, same as any other object mutation.
    leakedTarget!.locale = "fr";
    expect(leakedTarget!.locale).toBe("fr");

    // Navigation/refresh install the NEXT page's payload the same way
    // `navigation-root.tsx` and `refresh.ts` do.
    hydrateShared({ locale: "en" });

    const view = useShared() as Record<string, any>;
    expect(view.locale).toBe("en");
    expect(view.locale).not.toBe("fr");
  });
});
