/**
 * React 19's `use()` reads an ALREADY-settled value synchronously only when
 * handed a "tracked" thenable — one already carrying `status`/`value` (or
 * `reason`) — never a bare `Promise`, which `use()` always suspends on at
 * least once even when it happens to already be fulfilled. This is the one
 * place that shape gets built, for a caller that has a value in hand right
 * now and needs `use()` to accept it without ever suspending.
 */
export type SettledThenable<T> = Promise<T> & { status: "fulfilled"; value: T };

export function createSettledThenable<T>(value: T): SettledThenable<T> {
  const thenable = Promise.resolve(value) as SettledThenable<T>;

  thenable.status = "fulfilled";
  thenable.value = value;

  return thenable;
}
