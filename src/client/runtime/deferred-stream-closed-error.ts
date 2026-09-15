/**
 * Rejection reason for a deferred key that never settled before the
 * hydration stream ended — the connection was cut, or the server never sent
 * a chunk for it. Raised by `installStreamClosedRejection` on
 * `DOMContentLoaded` for every key still pending at that point (Stage 2
 * implementation contract, rule 8).
 *
 * No hard navigation follows a stream-closed rejection: the hydration
 * payload itself was complete, and only this deferred value failed to
 * arrive, so the nearest error boundary handles it exactly like any other
 * deferred rejection.
 */
export class DeferredStreamClosedError extends Error {
  /**
   * @param key The deferred key that never settled.
   */
  public constructor(public readonly key: string) {
    super(`Warlock deferred value "${key}" never settled before the stream closed.`);
    this.name = "DeferredStreamClosedError";
  }
}
