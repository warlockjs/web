import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onClientError,
  reportClientError,
  resetClientErrorReporterForTests,
  type ClientErrorEvent,
} from "./report-client-error";

describe("reportClientError() / onClientError()", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetClientErrorReporterForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetClientErrorReporterForTests();
  });

  it("always writes the unconditional console floor, even with no callback registered", () => {
    reportClientError("boom happened", new Error("boom"), { kind: "boundary" });

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[warlock:web] boom happened:", expect.any(Error));
  });

  it("does not throw when no callback is registered", () => {
    expect(() =>
      reportClientError("boom", new Error("boom"), { kind: "window-error" }),
    ).not.toThrow();
  });

  it("calls the registered callback once per failure class", () => {
    const callback = vi.fn();
    onClientError(callback);

    reportClientError("window error", new Error("a"), { kind: "window-error" });
    reportClientError("unhandled rejection", new Error("b"), { kind: "unhandled-rejection" });
    reportClientError("hydration mismatch", new Error("c"), { kind: "hydration" });
    reportClientError("boundary caught it", new Error("d"), { kind: "boundary" });

    expect(callback).toHaveBeenCalledTimes(4);
    expect(callback.mock.calls.map(([event]) => (event as ClientErrorEvent).kind)).toEqual([
      "window-error",
      "unhandled-rejection",
      "hydration",
      "boundary",
    ]);
  });

  it("dedupes the same Error object reported twice into one callback call", () => {
    const callback = vi.fn();
    onClientError(callback);
    const sharedError = new Error("shared failure");

    reportClientError("first observation", sharedError, { kind: "window-error" });
    reportClientError("second observation", sharedError, { kind: "boundary" });

    // The console floor still logs both distinct messages.
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("red control: two DIFFERENT error objects with identical content are never deduped", () => {
    const callback = vi.fn();
    onClientError(callback);

    reportClientError("first", new Error("same message"), { kind: "boundary" });
    reportClientError("second", new Error("same message"), { kind: "boundary" });

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing callback: logs once, never recurses, never leaves an unhandled rejection", () => {
    const callback = vi.fn(() => {
      throw new Error("callback is broken");
    });
    onClientError(callback);

    expect(() => reportClientError("boom", new Error("boom"), { kind: "boundary" })).not.toThrow();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "[warlock:web] the registered client error callback threw:",
      expect.any(Error),
    );

    // A LATER, distinct failure still reaches the (still-broken) callback —
    // the earlier throw did not permanently disable dispatch.
    reportClientError("boom again", new Error("boom again"), { kind: "boundary" });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("registering a new callback replaces the previous one", () => {
    const first = vi.fn();
    const second = vi.fn();
    onClientError(first);
    onClientError(second);

    reportClientError("boom", new Error("boom"), { kind: "boundary" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
