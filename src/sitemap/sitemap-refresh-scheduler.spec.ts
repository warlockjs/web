import { describe, expect, it, vi } from "vitest";
import {
  SitemapRefreshScheduler,
  type SitemapRefreshTimer,
  type SitemapRefreshTimerPort,
} from "./sitemap-refresh-scheduler";

function createTimers(): SitemapRefreshTimerPort & {
  readonly timeouts: Map<
    SitemapRefreshTimer,
    { readonly callback: () => void; readonly delayMs: number }
  >;
  readonly intervals: Map<
    SitemapRefreshTimer,
    { readonly callback: () => void; readonly delayMs: number }
  >;
} {
  const timeouts = new Map<
    SitemapRefreshTimer,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  const intervals = new Map<
    SitemapRefreshTimer,
    { readonly callback: () => void; readonly delayMs: number }
  >();

  return {
    timeouts,
    intervals,
    setTimeout(callback, delayMs) {
      const timer = {};
      timeouts.set(timer, { callback, delayMs });
      return timer;
    },
    clearTimeout(timer) {
      timeouts.delete(timer);
    },
    setInterval(callback, delayMs) {
      const timer = {};
      intervals.set(timer, { callback, delayMs });
      return timer;
    },
    clearInterval(timer) {
      intervals.delete(timer);
    },
  };
}

describe("SitemapRefreshScheduler", () => {
  it("starts an optional interval once without an immediate trigger", () => {
    const timers = createTimers();
    const trigger = vi.fn();
    const scheduler = new SitemapRefreshScheduler({ trigger, intervalMs: 60_000, timers });

    scheduler.start();
    scheduler.start();

    expect(trigger).not.toHaveBeenCalled();
    expect(timers.intervals.size).toBe(1);
    [...timers.intervals.values()][0]?.callback();
    expect(trigger).toHaveBeenCalledWith("interval");
  });

  it("uses the quiet timer once across repeated invalidations", () => {
    const timers = createTimers();
    const trigger = vi.fn();
    const scheduler = new SitemapRefreshScheduler({ trigger, timers });

    scheduler.invalidate();
    const maxWait = [...timers.timeouts.values()].find(({ delayMs }) => delayMs === 300_000);
    scheduler.invalidate();

    expect(timers.timeouts.size).toBe(2);
    const quiet = [...timers.timeouts.values()].find(({ delayMs }) => delayMs === 30_000);
    quiet?.callback();

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("invalidation");
    expect(timers.timeouts.size).toBe(0);
    expect(maxWait).toBeDefined();
  });

  it("fires the max-wait deadline when invalidations never become quiet", () => {
    const timers = createTimers();
    const trigger = vi.fn();
    const scheduler = new SitemapRefreshScheduler({ trigger, timers });

    scheduler.invalidate();
    const maxWait = [...timers.timeouts.values()].find(({ delayMs }) => delayMs === 300_000);
    scheduler.invalidate();
    maxWait?.callback();

    expect(trigger).toHaveBeenCalledWith("invalidation");
    expect(timers.timeouts.size).toBe(0);
  });

  it("reports thrown and rejected triggers without unhandled scheduled work", async () => {
    const timers = createTimers();
    const reportError = vi.fn();
    const error = new Error("refresh failed");
    const scheduler = new SitemapRefreshScheduler({
      timers,
      reportError,
      trigger: vi.fn().mockRejectedValue(error),
    });

    scheduler.invalidate();
    [...timers.timeouts.values()].find(({ delayMs }) => delayMs === 30_000)?.callback();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith(error);
  });

  it("clears timers and prevents callbacks after disposal", () => {
    const timers = createTimers();
    const trigger = vi.fn();
    const scheduler = new SitemapRefreshScheduler({ trigger, intervalMs: 60_000, timers });

    scheduler.start();
    scheduler.invalidate();
    scheduler.dispose();
    scheduler.invalidate();

    expect(timers.intervals.size).toBe(0);
    expect(timers.timeouts.size).toBe(0);
    expect(trigger).not.toHaveBeenCalled();
  });
});
