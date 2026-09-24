export type SitemapRefreshReason = "interval" | "invalidation";

export type SitemapRefreshTrigger = (reason: SitemapRefreshReason) => void | Promise<unknown>;

export type SitemapRefreshErrorReporter = (error: unknown) => void;

export type SitemapRefreshTimer = {
  unref?: () => unknown;
};

export type SitemapRefreshTimerPort = {
  setTimeout(callback: () => void, delayMs: number): SitemapRefreshTimer;
  clearTimeout(timer: SitemapRefreshTimer): void;
  setInterval(callback: () => void, delayMs: number): SitemapRefreshTimer;
  clearInterval(timer: SitemapRefreshTimer): void;
};

export type SitemapRefreshSchedulerOptions = {
  readonly trigger: SitemapRefreshTrigger;
  readonly reportError?: SitemapRefreshErrorReporter;
  /** An already-parsed interval. Omit it to disable interval refreshes. */
  readonly intervalMs?: number;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly timers?: SitemapRefreshTimerPort;
};

const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 300_000;

const defaultTimers: SitemapRefreshTimerPort = {
  setTimeout: (callback, delayMs) =>
    globalThis.setTimeout(callback, delayMs) as unknown as SitemapRefreshTimer,
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (callback, delayMs) =>
    globalThis.setInterval(callback, delayMs) as unknown as SitemapRefreshTimer,
  clearInterval: (timer) =>
    globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>),
};

/**
 * Owns only refresh timing. Its trigger is deliberately injected so the
 * caller may delegate serialization and generation to another component.
 */
export class SitemapRefreshScheduler {
  private readonly trigger: SitemapRefreshTrigger;
  private readonly reportError?: SitemapRefreshErrorReporter;
  private readonly intervalMs?: number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly timers: SitemapRefreshTimerPort;
  private intervalTimer?: SitemapRefreshTimer;
  private quietTimer?: SitemapRefreshTimer;
  private maxWaitTimer?: SitemapRefreshTimer;
  private started = false;
  private disposed = false;

  public constructor(options: SitemapRefreshSchedulerOptions) {
    this.trigger = options.trigger;
    this.reportError = options.reportError;
    this.intervalMs = options.intervalMs;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  /** Starts the optional interval once. Starting never triggers generation immediately. */
  public start(): void {
    if (this.started || this.disposed) return;

    this.started = true;

    if (this.intervalMs === undefined || this.intervalMs <= 0) return;

    this.intervalTimer = this.timers.setInterval(() => this.fire("interval"), this.intervalMs);
    this.intervalTimer.unref?.();
  }

  /**
   * Coalesces invalidations until the quiet period elapses, while the first
   * invalidation's max-wait deadline prevents a busy stream from starving a
   * refresh forever.
   */
  public invalidate(): void {
    if (this.disposed) return;

    this.clearQuietTimer();
    this.quietTimer = this.timers.setTimeout(() => this.fireInvalidation(), this.debounceMs);
    this.quietTimer.unref?.();

    if (this.maxWaitTimer) return;

    this.maxWaitTimer = this.timers.setTimeout(() => this.fireInvalidation(), this.maxWaitMs);
    this.maxWaitTimer.unref?.();
  }

  /** Clears scheduled work. An invocation already given to `trigger` cannot be cancelled. */
  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.clearQuietTimer();
    this.clearMaxWaitTimer();

    if (this.intervalTimer) {
      this.timers.clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }

  private fireInvalidation(): void {
    if (this.disposed) return;

    this.clearQuietTimer();
    this.clearMaxWaitTimer();
    this.fire("invalidation");
  }

  private fire(reason: SitemapRefreshReason): void {
    if (this.disposed) return;

    try {
      void Promise.resolve(this.trigger(reason)).catch((error: unknown) =>
        this.reportFailure(error),
      );
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private clearQuietTimer(): void {
    if (!this.quietTimer) return;

    this.timers.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  private clearMaxWaitTimer(): void {
    if (!this.maxWaitTimer) return;

    this.timers.clearTimeout(this.maxWaitTimer);
    this.maxWaitTimer = undefined;
  }

  private reportFailure(error: unknown): void {
    try {
      this.reportError?.(error);
    } catch {
      // Error reporting must not turn a scheduled callback into an unhandled rejection.
    }
  }
}
