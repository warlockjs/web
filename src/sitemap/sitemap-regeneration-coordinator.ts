/** A pure, single-process sequencer for externally triggered sitemap generation. */
export type SitemapRegenerationRunner<Result> = (revision: number) => Promise<Result>;

/** Receives failures after the requests attached to that generation are rejected. */
export type SitemapRegenerationErrorReporter = (error: unknown) => void;

export type SitemapRegenerationCoordinatorOptions<Result> = {
  readonly run: SitemapRegenerationRunner<Result>;
  readonly reportError?: SitemapRegenerationErrorReporter;
};

export class SitemapRegenerationCoordinatorDisposedError extends Error {
  public constructor() {
    super("Sitemap regeneration coordinator has been disposed.");
    this.name = "SitemapRegenerationCoordinatorDisposedError";
  }
}

type RegenerationWaiter<Result> = {
  readonly revision: number;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
};

/**
 * Serializes regeneration without assuming that an application's generator,
 * storage, or error reporter has any particular implementation.
 *
 * A request made while a pass is running always waits for a pass which starts
 * after that request. Calls received during that follow-up pass consequently
 * create one later pass. The revision numbers are process-local sequence
 * numbers, intentionally not timestamps.
 */
export class SitemapRegenerationCoordinator<Result> {
  private readonly run: SitemapRegenerationRunner<Result>;
  private readonly reportError?: SitemapRegenerationErrorReporter;
  private readonly waiters: RegenerationWaiter<Result>[] = [];
  private running = false;
  private disposed = false;
  private settledRevision = 0;
  private nextRequestedRevision = 0;
  private nextCompletedRevision = 0;

  public constructor(options: SitemapRegenerationCoordinatorOptions<Result>) {
    this.run = options.run;
    this.reportError = options.reportError;
  }

  /** The most recent request number accepted by this coordinator. */
  public get requestedRevision(): number {
    return this.nextRequestedRevision;
  }

  /** The most recent generation revision that completed successfully. */
  public get completedRevision(): number {
    return this.nextCompletedRevision;
  }

  public get isRunning(): boolean {
    return this.running;
  }

  /**
   * Request a generation. While another pass is active, this promise belongs
   * to the first pass that begins afterwards, never to the active pass.
   */
  public request(): Promise<Result> {
    if (this.disposed) return Promise.reject(new SitemapRegenerationCoordinatorDisposedError());

    const revision = ++this.nextRequestedRevision;
    const promise = new Promise<Result>((resolve, reject) => {
      this.waiters.push({ revision, resolve, reject });
    });

    if (!this.running) this.startNextRun();

    return promise;
  }

  /**
   * Prevents a queued follow-up and rejects callers still waiting. It does not
   * attempt to cancel a runner that has already started.
   */
  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    const error = new SitemapRegenerationCoordinatorDisposedError();

    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private startNextRun(): void {
    if (this.disposed || this.running || this.settledRevision >= this.nextRequestedRevision) return;

    const revision = this.nextRequestedRevision;
    this.running = true;

    void Promise.resolve()
      .then(() => this.run(revision))
      .then(
        (result) => {
          this.nextCompletedRevision = revision;
          this.settleWaiters(revision, result);
        },
        (error: unknown) => {
          this.settleWaiters(revision, error, true);
          this.reportFailure(error);
        },
      )
      .finally(() => {
        this.settledRevision = revision;
        this.running = false;

        if (!this.disposed && this.settledRevision < this.nextRequestedRevision)
          this.startNextRun();
      });
  }

  private settleWaiters(revision: number, value: Result | unknown, rejected = false): void {
    const remaining: RegenerationWaiter<Result>[] = [];

    for (const waiter of this.waiters) {
      if (waiter.revision > revision) {
        remaining.push(waiter);
        continue;
      }

      if (rejected) waiter.reject(value);
      else waiter.resolve(value as Result);
    }

    this.waiters.splice(0, this.waiters.length, ...remaining);
  }

  private reportFailure(error: unknown): void {
    try {
      this.reportError?.(error);
    } catch {
      // Reporting cannot change the request outcome or strand follow-up work.
    }
  }
}
