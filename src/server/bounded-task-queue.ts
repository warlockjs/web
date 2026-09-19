/**
 * A tiny FIFO task queue bounded on two independent axes, extracted out of
 * `./report-server-error.ts` (card 1db238ca, blocker 2) because it is a
 * single, self-contained responsibility: never how many ERROR REPORTS exist,
 * only how many lazy tasks may run at once and how many more may wait.
 *
 *   - CONCURRENCY: at most `concurrency` tasks are ever ACTIVE (started, not
 *     yet settled) at the same time.
 *   - QUEUE: a task pushed while the concurrency limit is already saturated
 *     is NOT started — it is stored, unstarted, in a bounded FIFO queue of
 *     at most `maxQueued` entries.
 *
 * Pushing past both bounds drops the OLDEST QUEUED (i.e. not-yet-started)
 * task, never an already-active one — an active call already has real work
 * underway; a queued one is still just a closure nobody has invoked yet, so
 * dropping it costs nothing that has already happened.
 *
 * As each active task settles, the next queued task (if any) is dequeued and
 * started immediately, so the queue only ever holds entries while every
 * concurrency slot is occupied.
 */
export type BoundedTaskQueueOptions = {
  /** Maximum number of tasks that may be started and not yet settled at once. */
  concurrency: number;
  /** Maximum number of not-yet-started tasks the queue may hold. */
  maxQueued: number;
  /** Called once per dropped, not-yet-started task, oldest first. */
  onDrop?: () => void;
};

export class BoundedTaskQueue {
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly onDrop?: () => void;
  private readonly active = new Set<Promise<void>>();
  private queue: Array<() => Promise<void>> = [];

  constructor(options: BoundedTaskQueueOptions) {
    this.concurrency = options.concurrency;
    this.maxQueued = options.maxQueued;
    this.onDrop = options.onDrop;
  }

  /**
   * Starts `task` immediately when a concurrency slot is free; otherwise
   * queues it, dropping the oldest queued (not-yet-started) task first when
   * the queue is already at `maxQueued`.
   */
  push(task: () => Promise<void>): void {
    if (this.active.size < this.concurrency) {
      this.start(task);
      return;
    }

    if (this.queue.length >= this.maxQueued) {
      this.queue.shift();
      this.onDrop?.();
    }

    this.queue.push(task);
  }

  private start(task: () => Promise<void>): void {
    let settled!: Promise<void>;
    settled = task().finally(() => {
      this.active.delete(settled);

      const next = this.queue.shift();
      if (next !== undefined) this.start(next);
    });

    this.active.add(settled);
  }

  /** How many tasks are currently started and not yet settled. */
  get activeCount(): number {
    return this.active.size;
  }

  /** How many tasks are queued, not yet started. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Awaits every active AND queued task, capped at `timeoutMs` total. Queued
   * tasks drain naturally as active slots free up, so waiting for the active
   * set to empty is enough — a queued task only exists while the active set
   * is at capacity.
   */
  async drain(timeoutMs: number): Promise<void> {
    const settleEverything = (async (): Promise<void> => {
      while (this.active.size > 0) {
        await Promise.race([...this.active]);
      }
    })();

    const cap = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });

    await Promise.race([settleEverything, cap]);
  }

  /** Test-only: drop all active/queued bookkeeping without settling anything. */
  reset(): void {
    this.active.clear();
    this.queue = [];
  }
}
