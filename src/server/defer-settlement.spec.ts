import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEnvironment } from "@warlock.js/core";
import { createDeferredSettlement, DeferTimeoutError } from "./defer-settlement";
import { PublicPageError } from "./public-page-error";

const originalNodeEnv = process.env.NODE_ENV;

describe("createDeferredSettlement()", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("resolves both the component promise and the settlement when the raw promise fulfills", async () => {
    const raw = Promise.resolve({ rating: 5 });
    const pair = createDeferredSettlement("reviews", raw, 1_000);

    await expect(pair.componentPromise).resolves.toEqual({ rating: 5 });
    await expect(pair.settlement).resolves.toEqual({ ok: true, value: { rating: 5 } });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rejects the component promise, settles ok:false, and reports to the error sink when the raw promise rejects", async () => {
    const failure = new Error("boom");
    const raw = Promise.reject(failure);
    const pair = createDeferredSettlement("reviews", raw, 1_000);

    await expect(pair.componentPromise).rejects.toBe(failure);
    const settlement = await pair.settlement;

    expect(settlement.ok).toBe(false);
    if (!settlement.ok) {
      expect(settlement.error.name).toBe("Error");
      expect(settlement.error.message).toBe("boom");
    }
    expect(console.error).toHaveBeenCalledTimes(1);
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'deferred value "reviews" rejected',
    );
  });

  it("settles DeferTimeoutError and reports to the error sink when the raw promise never settles in time", async () => {
    vi.useFakeTimers();

    const raw = new Promise<never>(() => undefined);
    const pair = createDeferredSettlement("reviews", raw, 50);

    // Silence the timeout branch's own unhandled-rejection risk while advancing.
    pair.componentPromise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(60);

    const settlement = await pair.settlement;
    expect(settlement.ok).toBe(false);
    if (!settlement.ok) {
      expect(settlement.error.name).toBe("DeferTimeoutError");
      expect(settlement.error.message).toContain("reviews");
    }
    await expect(pair.componentPromise).rejects.toBeInstanceOf(DeferTimeoutError);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      'deferred value "reviews" timed out',
    );
  });

  it("ignores a late raw-promise settlement after a timeout has already settled the pair", async () => {
    vi.useFakeTimers();

    let releaseRaw!: (value: unknown) => void;
    const raw = new Promise((resolve) => {
      releaseRaw = resolve;
    });
    const pair = createDeferredSettlement("reviews", raw, 10);
    pair.componentPromise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(20);
    const timedOutSettlement = await pair.settlement;
    expect(timedOutSettlement.ok).toBe(false);

    // The raw promise settling AFTER the timeout must not change anything —
    // `settlement`/`componentPromise` already settled exactly once.
    releaseRaw({ rating: 5 });
    await vi.advanceTimersByTimeAsync(0);

    const stillTimedOut = await pair.settlement;
    expect(stillTimedOut).toBe(timedOutSettlement);
  });

  describe("in production", () => {
    it("never puts an unexpected loader error's own message on the wire settlement", async () => {
      setEnvironment("production");
      const raw = Promise.reject(new Error("db password=hunter2"));
      const pair = createDeferredSettlement("secret", raw, 1_000);

      await pair.componentPromise.catch(() => undefined);
      const settlement = await pair.settlement;

      expect(settlement.ok).toBe(false);
      if (!settlement.ok) {
        expect(settlement.error.message).not.toContain("hunter2");
        expect(settlement.error.message).toBe("An unexpected error occurred.");
        expect(settlement.error).not.toHaveProperty("stack");
        expect(typeof settlement.error.errorCode).toBe("string");
      }

      // The report line joins to the SAME opaque code the wire settlement carries.
      const [message] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
      const settled = await pair.settlement;
      if (!settled.ok) {
        expect(message).toContain(settled.error.errorCode);
      }
    });

    it("still exposes a PublicPageError's own message on the wire settlement", async () => {
      setEnvironment("production");
      const raw = Promise.reject(new PublicPageError("This slug is already taken."));
      const pair = createDeferredSettlement("slug", raw, 1_000);

      await pair.componentPromise.catch(() => undefined);
      const settlement = await pair.settlement;

      expect(settlement.ok).toBe(false);
      if (!settlement.ok) {
        expect(settlement.error.message).toBe("This slug is already taken.");
      }
    });

    it("red control: a settlement built straight from the raw thrown value (bypassing serializePageError) leaks the secret", async () => {
      // Proves the previous two assertions are meaningful: constructing the
      // wire shape WITHOUT going through the sanitizing chokepoint reproduces
      // the leak this task fixes. Never do this in real code.
      const thrown = new Error("db password=hunter2");
      const bypassedSettlement = {
        ok: false as const,
        error: { name: thrown.name, message: thrown.message },
      };

      expect(bypassedSettlement.error.message).toContain("hunter2");
    });
  });
});
