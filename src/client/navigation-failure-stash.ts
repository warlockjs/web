/**
 * Carries the ORIGINAL error of a failed client navigation across the full page
 * load it triggers.
 *
 * `NavigationRoot` answers a page tree that will not build (a page chunk that
 * fails to load or evaluate, most often because a server-only barrel was
 * imported from browser code) by calling `window.location.assign(url)`. The
 * original error was only ever written to the console of the document that is
 * then thrown away. The reloaded document breaks the same way, one step later
 * and in a different shape (typically `useLocale() was called outside Warlock's
 * LocaleProvider`), and that follow-on error is the only one left on screen.
 *
 * So the original is parked in `sessionStorage` just before the reload and
 * logged FIRST by the next document, ahead of anything it renders, as the ROOT
 * CAUSE. Anything reported afterwards through `reportClientError` is then
 * marked as a probable consequence of it.
 *
 * Every storage access is guarded: a private window or blocked storage must
 * never turn a recoverable fallback into a second failure.
 */
import { markRootCauseLogged, reportClientError } from "./report-client-error";

/** The `sessionStorage` key the stash lives under. */
export const NAVIGATION_FAILURE_STORAGE_KEY = "warlock:web:navigation-failure";

type StashedNavigationFailure = {
  url: string;
  name: string;
  message: string;
  stack?: string;
};

function describe(error: unknown): Pick<StashedNavigationFailure, "name" | "message" | "stack"> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }

  return { name: "Error", message: String(error) };
}

/**
 * Park `error` so the document the browser is about to load can log it first.
 * Call immediately before `window.location.assign(url)`.
 */
export function stashNavigationFailure(url: string, error: unknown): void {
  try {
    const record: StashedNavigationFailure = { url, ...describe(error) };

    window.sessionStorage.setItem(NAVIGATION_FAILURE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable: the console.warn the caller already wrote is all we have.
  }
}

/**
 * Log the error a previous document stashed, if there is one, and forget it.
 * Returns whether anything was logged. Call before the new document renders.
 */
export function replayStashedNavigationFailure(): boolean {
  let raw: string | null;

  try {
    raw = window.sessionStorage.getItem(NAVIGATION_FAILURE_STORAGE_KEY);

    if (raw === null) return false;

    window.sessionStorage.removeItem(NAVIGATION_FAILURE_STORAGE_KEY);
  } catch {
    return false;
  }

  let record: StashedNavigationFailure;

  try {
    const parsed = JSON.parse(raw) as Partial<StashedNavigationFailure> | null;

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.message !== "string" ||
      typeof parsed.url !== "string"
    ) {
      return false;
    }

    record = {
      url: parsed.url,
      name: typeof parsed.name === "string" ? parsed.name : "Error",
      message: parsed.message,
      stack: typeof parsed.stack === "string" ? parsed.stack : undefined,
    };
  } catch {
    return false;
  }

  const original = new Error(record.message);

  original.name = record.name;
  // The stack names the module that failed; keep it exactly as the browser wrote it.
  if (record.stack !== undefined) original.stack = record.stack;

  reportClientError(
    `ROOT CAUSE: the client navigation to ${record.url} failed and fell back to this full page load. ` +
      "Errors logged after this line are probably consequences of it",
    original,
    {
      kind: "navigation",
      pathname: typeof window === "undefined" ? undefined : window.location.pathname,
    },
  );
  markRootCauseLogged();

  return true;
}
