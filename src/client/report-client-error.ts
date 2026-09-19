/**
 * THE client-side error reporting seam (card 1db238ca, audit §1.1-1.2, Aria's
 * binding 5.17 ruling). Every client error path in `web` — an uncaught
 * `window` error, an unhandled promise rejection, a React hydration
 * recoverable error, and the framework's own `DefaultErrorBoundary` —
 * funnels through {@link reportClientError}, which does two things, in this
 * order, on every call:
 *
 *   1. Writes an UNCONDITIONAL line to `console.error` — the pre-existing
 *      floor this function already was before this card, and still the ONE
 *      thing that can never be silenced by app config alone.
 *   2. Hands the error to an app-owned callback, when one has been
 *      registered via {@link onClientError} — deliberately NO network
 *      endpoint here (Aria's ruling defers the framework-owned public beacon
 *      to a later release); the app decides what to do with the error,
 *      including sending it somewhere itself.
 *
 * DEDUPE: the same Error OBJECT reported twice (the boundary re-rendering
 * the same failure, for example) reaches the registered callback exactly
 * once — enforced with a marker symbol stamped onto the object itself, the
 * same mechanism `../server/report-server-error.ts` uses for its own dedupe.
 * The console floor is UNAFFECTED — every call site's own message still logs
 * every time.
 */

/** What kind of client-side failure produced this report. */
export type ClientErrorKind = "window-error" | "unhandled-rejection" | "hydration" | "boundary";

/** What a registered {@link ClientErrorReporter} receives. */
export type ClientErrorEvent = {
  error: unknown;
  kind: ClientErrorKind;
  /** The current route's name, when it is known at report time. */
  routeName?: string;
  /** `window.location.pathname` at report time. */
  pathname?: string;
};

/**
 * An app-owned callback for a client-side failure, in ADDITION to the
 * unconditional `console.error` floor, never a replacement for it. Register
 * one with {@link onClientError} from the app's own client code (e.g. its
 * `src/web/root.tsx` or hydration entry). A throw or a rejection from this
 * callback is caught once, logged once, and never fed back into itself (no
 * recursion) — see {@link reportClientError}.
 *
 * Typed `void | Promise<void>`, not just `void`: an async reporter is a
 * `Promise<void>`-returning function, which is assignable to a `void`-typed
 * signature — TypeScript would happily accept it, but nothing would ever
 * observe its rejection. Naming the promise here is what lets
 * {@link reportClientError} attach a rejection handler instead of letting an
 * async reporter's rejection escape as a NEW `unhandledrejection`, which
 * `hydrate-page.tsx`'s window listener would report as a fresh failure and
 * call this same (broken) reporter again — an unbounded loop.
 */
export type ClientErrorReporter = (event: ClientErrorEvent) => void | Promise<void>;

/** `true` when `value` is thenable — covers a real `Promise` and any promise-like. */
function isThenable(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

const REPORTED_TO_APP_CALLBACK = Symbol.for("warlock.web.clientErrorReportedToAppCallback");

let registeredReporter: ClientErrorReporter | undefined;

/**
 * Register the app-owned client error callback (Aria's ruling: "an explicit
 * app-owned callback registered in the browser, still alongside console").
 * Calling this again REPLACES the previously registered callback — there is
 * exactly one active reporter at a time, the same single-hook shape
 * `web.errors.report` uses on the server.
 */
export function onClientError(reporter: ClientErrorReporter): void {
  registeredReporter = reporter;
}

/** Test-only: clear the registered callback between specs. */
export function resetClientErrorReporterForTests(): void {
  registeredReporter = undefined;
}

function alreadyReportedToAppCallback(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) return false;

  const record = thrown as Record<PropertyKey, unknown>;

  try {
    if (record[REPORTED_TO_APP_CALLBACK] === true) return true;

    record[REPORTED_TO_APP_CALLBACK] = true;
    return false;
  } catch {
    return false;
  }
}

/**
 * The unconditional console floor for a client-side failure that must never
 * be silenced by a configurable sink alone — mirrors
 * `../server/report-server-error.ts`'s identical convention for the server
 * half of this pipeline. Also dispatches to the registered
 * {@link onClientError} callback, when one is registered, deduped per error
 * object and isolated from its own failures (see the file header).
 */
export function reportClientError(
  context: string,
  thrown: unknown,
  event: Omit<ClientErrorEvent, "error"> = { kind: "boundary" },
): void {
  console.error(`[warlock:web] ${context}:`, thrown);

  if (registeredReporter === undefined) return;
  if (alreadyReportedToAppCallback(thrown)) return;

  try {
    const result = registeredReporter({ error: thrown, ...event });

    if (isThenable(result)) {
      // ISOLATION for the ASYNC case: attach the rejection handler right
      // here, synchronously, so a rejected promise from an async reporter
      // never reaches the engine as an unhandled rejection — see the
      // `ClientErrorReporter` doc comment. Logged once, directly, and never
      // routed back through `reportClientError`/`onClientError` for this
      // failure, so a reporter that always rejects can never recurse into
      // itself via `hydrate-page.tsx`'s `unhandledrejection` listener.
      result.then(undefined, (reporterError: unknown) => {
        console.error(
          "[warlock:web] the registered client error callback rejected:",
          reporterError,
        );
      });
    }
  } catch (reporterError) {
    // ISOLATION for the SYNCHRONOUS case: logged once, directly — never
    // routed back through `reportClientError`/the registered callback for
    // THIS failure, so a callback that always throws can never recurse into
    // itself.
    console.error("[warlock:web] the registered client error callback threw:", reporterError);
  }
}
