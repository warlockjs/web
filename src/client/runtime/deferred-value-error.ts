/**
 * The client-side rejection reason for a deferred loader value that settled
 * as an error.
 *
 * Constructed only from the wire-safe settlement shape the server sends —
 * `{ name, message, statusCode? }` (Stage 2 implementation contract, rule 5)
 * — never from the original thrown value, which does not cross the wire and
 * never carries a stack in production. `use()` throws an instance of this to
 * the nearest error boundary, exactly as it would a loader error thrown
 * synchronously during SSR.
 */
export class DeferredValueError extends Error {
  /**
   * @param message The settlement's `error.message`.
   * @param statusCode The settlement's optional `error.statusCode`.
   */
  public constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DeferredValueError";
  }
}
