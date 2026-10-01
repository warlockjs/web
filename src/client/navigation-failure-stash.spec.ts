import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_FAILURE_STORAGE_KEY,
  replayStashedNavigationFailure,
  stashNavigationFailure,
} from "./navigation-failure-stash";
import { reportClientError, resetClientErrorReporterForTests } from "./report-client-error";

/**
 * A `sessionStorage` that outlives the "document" it was written from, the one
 * property the stash depends on: the same store is handed to the old document
 * (which parks the error) and to the new one (which replays it).
 */
function makeSessionStorage() {
  const entries = new Map<string, string>();

  return {
    entries,
    storage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    },
  };
}

describe("navigation failure stash — the ORIGINAL error survives the full-load fallback", () => {
  let session: ReturnType<typeof makeSessionStorage>;

  beforeEach(() => {
    session = makeSessionStorage();
    vi.stubGlobal("window", {
      sessionStorage: session.storage,
      location: { pathname: "/dashboard" },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetClientErrorReporterForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetClientErrorReporterForTests();
  });

  it("logs the original error FIRST in the next document and marks the LocaleProvider error after it as a consequence", () => {
    const original = new Error(
      "Failed to resolve import './server-only-barrel' from 'src/web/dashboard.page.tsx'",
    );
    original.name = "ModuleGraphError";
    original.stack = "ModuleGraphError: boom\n    at src/web/dashboard.page.tsx:3:1";

    // Old document: the tree would not build, so it parks the error and reloads.
    stashNavigationFailure("/dashboard", original);

    // New document: the replay runs before anything renders...
    expect(replayStashedNavigationFailure()).toBe(true);

    // ...and then hydration trips over the follow-on error.
    const secondary = new Error(
      "useLocale() was called outside Warlock's LocaleProvider. Render the component " +
        "through the @warlock.js/web page pipeline.",
    );

    reportClientError("an uncaught window error", secondary, { kind: "window-error" });

    const calls = vi.mocked(console.error).mock.calls;

    expect(calls).toHaveLength(2);

    const [firstMessage, firstError] = calls[0] as [string, Error];
    const [secondMessage, secondError] = calls[1] as [string, Error];

    expect(firstMessage).toContain("ROOT CAUSE");
    expect(firstMessage).toContain("/dashboard");
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError.name).toBe("ModuleGraphError");
    expect(firstError.message).toBe(original.message);
    expect(firstError.stack).toBe(original.stack);

    expect(secondMessage).toContain("CONSEQUENCE");
    expect(secondMessage).toContain("ROOT CAUSE logged above");
    expect(secondError).toBe(secondary);
  });

  it("replays at most once and leaves nothing behind", () => {
    stashNavigationFailure("/dashboard", new Error("first"));

    expect(replayStashedNavigationFailure()).toBe(true);
    expect(session.entries.has(NAVIGATION_FAILURE_STORAGE_KEY)).toBe(false);
    expect(replayStashedNavigationFailure()).toBe(false);
  });

  it("does not mark ordinary errors as consequences when nothing was stashed", () => {
    expect(replayStashedNavigationFailure()).toBe(false);

    reportClientError("an uncaught window error", new Error("plain"), { kind: "window-error" });

    expect(console.error).toHaveBeenCalledWith(
      "[warlock:web] an uncaught window error:",
      expect.any(Error),
    );
  });

  it("stashes a non-Error value as its string form", () => {
    stashNavigationFailure("/dashboard", "string failure");

    replayStashedNavigationFailure();

    const [, replayed] = vi.mocked(console.error).mock.calls[0] as [string, Error];

    expect(replayed.message).toBe("string failure");
  });

  it("survives unusable storage: stashing and replaying never throw", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
      location: { pathname: "/" },
    });

    expect(() => stashNavigationFailure("/", new Error("x"))).not.toThrow();
    expect(replayStashedNavigationFailure()).toBe(false);
  });

  it("ignores a corrupt stash entry", () => {
    session.entries.set(NAVIGATION_FAILURE_STORAGE_KEY, "{not json");

    expect(replayStashedNavigationFailure()).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });
});
