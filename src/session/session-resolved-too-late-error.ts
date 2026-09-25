/**
 * Thrown (development) or logged (production) when a session resolver would
 * set a renewal cookie after the response headers were already committed.
 * Stage 2.5 exists so that resolution happens before `writeHead`.
 */
export class SessionResolvedTooLateError extends Error {
  public constructor() {
    super(
      "The page session was resolved after the response headers were committed, so a renewal " +
        "cookie can no longer be sent. Fix: let the framework resolve the session (web.session) " +
        "before loaders run, and do not call the resolver from streamed or deferred work.",
    );
    this.name = "SessionResolvedTooLateError";
  }
}
