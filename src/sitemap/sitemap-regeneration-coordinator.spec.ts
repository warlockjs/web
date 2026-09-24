import { describe, expect, it, vi } from "vitest";
import {
  SitemapRegenerationCoordinator,
  SitemapRegenerationCoordinatorDisposedError,
} from "./sitemap-regeneration-coordinator";

type Deferred<Result> = {
  readonly promise: Promise<Result>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
};

function deferred<Result>(): Deferred<Result> {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("SitemapRegenerationCoordinator", () => {
  it("runs an idle request immediately and resolves it from that pass", async () => {
    const run = vi.fn(async (revision: number) => `result-${revision}`);
    const coordinator = new SitemapRegenerationCoordinator({ run });

    await expect(coordinator.request()).resolves.toBe("result-1");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(1);
    expect(coordinator.requestedRevision).toBe(1);
    expect(coordinator.completedRevision).toBe(1);
  });

  it("coalesces requests during one pass into one later pass", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const coordinator = new SitemapRegenerationCoordinator({ run });

    const firstRequest = coordinator.request();
    await Promise.resolve();
    const secondRequest = coordinator.request();
    const thirdRequest = coordinator.request();

    first.resolve("first");
    await expect(firstRequest).resolves.toBe("first");
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([revision]) => revision)).toEqual([1, 3]);

    second.resolve("second");
    await expect(Promise.all([secondRequest, thirdRequest])).resolves.toEqual(["second", "second"]);
  });

  it("queues another pass when a request arrives during the follow-up", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const coordinator = new SitemapRegenerationCoordinator({ run });

    const one = coordinator.request();
    await Promise.resolve();
    const two = coordinator.request();
    first.resolve("one");
    await one;
    await Promise.resolve();
    const three = coordinator.request();
    second.resolve("two");
    await two;
    await Promise.resolve();
    third.resolve("three");

    await expect(three).resolves.toBe("three");
    expect(run.mock.calls.map(([revision]) => revision)).toEqual([1, 2, 3]);
  });

  it("rejects only failed-pass waiters and runs a later pending revision", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const reportError = vi.fn();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const coordinator = new SitemapRegenerationCoordinator({ run, reportError });

    const one = coordinator.request();
    await Promise.resolve();
    const two = coordinator.request();
    const failure = new Error("generation failed");
    first.reject(failure);

    await expect(one).rejects.toBe(failure);
    await Promise.resolve();
    expect(run.mock.calls.map(([revision]) => revision)).toEqual([1, 2]);
    expect(coordinator.completedRevision).toBe(0);
    expect(reportError).toHaveBeenCalledWith(failure);

    second.resolve("recovered");
    await expect(two).resolves.toBe("recovered");
    expect(coordinator.completedRevision).toBe(2);
  });

  it("does not retry a failed revision without a newer request", async () => {
    const run = vi.fn(async () => {
      throw new Error("generation failed");
    });
    const coordinator = new SitemapRegenerationCoordinator({ run });

    await expect(coordinator.request()).rejects.toThrow("generation failed");
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
    expect(coordinator.completedRevision).toBe(0);
  });

  it("rejects outstanding callers and prevents follow-ups after disposal", async () => {
    const active = deferred<string>();
    const run = vi.fn().mockReturnValue(active.promise);
    const coordinator = new SitemapRegenerationCoordinator({ run });
    const current = coordinator.request();
    await Promise.resolve();
    const followUp = coordinator.request();

    coordinator.dispose();

    await expect(current).rejects.toBeInstanceOf(SitemapRegenerationCoordinatorDisposedError);
    await expect(followUp).rejects.toBeInstanceOf(SitemapRegenerationCoordinatorDisposedError);
    await expect(coordinator.request()).rejects.toBeInstanceOf(
      SitemapRegenerationCoordinatorDisposedError,
    );
    active.resolve("ignored");
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
