import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredSettlement, DeferTimeoutError } from "./defer-settlement";

describe("createDeferredSettlement()", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
});
