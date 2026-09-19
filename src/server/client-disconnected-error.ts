/**
 * The reason `web` hands to a React `PipeableStream`'s `abort(reason)`
 * whenever it aborts a render because the client went away — never for a
 * genuine render failure. Every abort site that closes a stream ON A CLIENT
 * DISCONNECT (`render-page.ts`'s `renderElementToPipeableStream`'s
 * `onError`, `defer-emission.ts`'s `onClientDisconnect`) stamps this class as
 * the reason so the React `onError` callback can tell "the client is gone" —
 * expected, load-bearing, must never alarm an operator — apart from an
 * actual bug in the render (card 0d43c0d6).
 *
 * Without a reason, React's own fallback message ("The render was aborted by
 * the server without a reason.") is indistinguishable from a real failure —
 * that ambiguity is exactly what this class closes.
 */
export class ClientDisconnectedError extends Error {
  public constructor() {
    super("The client disconnected before the SSR stream finished.");
    this.name = "ClientDisconnectedError";
  }
}
