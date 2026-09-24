// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "devalue";
import { hydrateRoot } from "react-dom/client";
import { HYDRATION_ROOT_ID, PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { hydratePage, resetWindowErrorReportersForTests } from "./hydrate-page";
import {
  onClientError,
  resetClientErrorReporterForTests,
  type ClientErrorEvent,
} from "./report-client-error";

/**
 * Card 1db238ca — the `window`-level and hydration-level halves of client
 * error reporting. `hydrateRoot` itself is mocked (same technique as
 * `hydrate-page.spec.ts`): what is under test is the WIRING — that a
 * `window` error, an unhandled rejection, and each of React's own hydration
 * error hooks reach `onClientError`'s registered callback exactly once — not
 * a real hydration pass.
 */
vi.mock("react-dom/client", () => ({
  hydrateRoot: vi.fn(),
}));

const validPayload = {
  appData: null,
  layoutData: {},
  pageData: {},
  shared: {},
  name: "main.home",
  locale: "en",
  translations: {},
};

function installFakeDocument(): { id: string; innerHTML: string } {
  const root = { id: HYDRATION_ROOT_ID, innerHTML: "<h1>server rendered</h1>" };

  vi.stubGlobal("document", {
    getElementById(id: string) {
      if (id === PAYLOAD_SCRIPT_ID) return { textContent: stringify(validPayload) };
      if (id === HYDRATION_ROOT_ID) return root;
      return null;
    },
  });

  return root;
}

beforeEach(() => {
  vi.mocked(hydrateRoot).mockClear();
  resetWindowErrorReportersForTests();
  resetClientErrorReporterForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetClientErrorReporterForTests();
});

describe("hydratePage — window-level error reporting", () => {
  it("reports an uncaught window error once", () => {
    installFakeDocument();
    const callback = vi.fn();
    onClientError(callback);

    hydratePage(() => "tree");

    const failure = new Error("window boom");
    window.dispatchEvent(new ErrorEvent("error", { error: failure, message: failure.message }));

    expect(callback).toHaveBeenCalledTimes(1);
    const [event] = callback.mock.calls[0] as [ClientErrorEvent];
    expect(event.kind).toBe("window-error");
    expect(event.error).toBe(failure);
  });

  it("reports an unhandled promise rejection once", () => {
    installFakeDocument();
    const callback = vi.fn();
    onClientError(callback);

    hydratePage(() => "tree");

    const failure = new Error("rejection boom");
    const rejectedPromise = Promise.reject(failure);
    rejectedPromise.catch(() => undefined);
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: rejectedPromise,
        reason: failure,
      }),
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const [event] = callback.mock.calls[0] as [ClientErrorEvent];
    expect(event.kind).toBe("unhandled-rejection");
    expect(event.error).toBe(failure);
  });

  it("installs the window listeners only once across multiple hydratePage calls", () => {
    installFakeDocument();
    const callback = vi.fn();
    onClientError(callback);

    hydratePage(() => "tree");
    hydratePage(() => "tree");

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") }));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no callback is registered", () => {
    installFakeDocument();
    hydratePage(() => "tree");

    expect(() =>
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") })),
    ).not.toThrow();
  });
});

describe("hydratePage — an async reporter that rejects never loops back through itself", () => {
  it("runs the async reporter exactly once and never lets its rejection reach the real unhandledrejection listener", async () => {
    installFakeDocument();

    // The real `window.addEventListener("unhandledrejection", ...)` — a
    // SEPARATE listener from `hydrate-page.tsx`'s own internal one — proves
    // whether the reporter's rejected promise ever escapes as a genuine
    // unhandled rejection, not just whether our own code "thinks" it handled
    // it.
    const realUnhandledRejectionListener = vi.fn();
    window.addEventListener("unhandledrejection", realUnhandledRejectionListener);

    let callCount = 0;
    onClientError(() => {
      callCount += 1;
      return Promise.reject(new Error("async reporter is broken"));
    });

    hydratePage(() => "tree");

    // A single, independent trigger — a `window` error, NOT an unhandled
    // rejection itself — is enough to reach the async reporter once. If its
    // rejection escaped, `hydrate-page.tsx`'s OWN internal
    // `unhandledrejection` listener would call `reportClientError` again
    // with `kind: "unhandled-rejection"`, which would call this same broken
    // reporter a second time — the unbounded loop this spec guards against.
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("window boom") }));

    // Give the engine's real promise-rejection tracking every chance to
    // surface a genuine `unhandledrejection` event before asserting it
    // never did — a plain `await Promise.resolve()` is not enough headroom
    // for that.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callCount).toBe(1);
    expect(realUnhandledRejectionListener).not.toHaveBeenCalled();

    window.removeEventListener("unhandledrejection", realUnhandledRejectionListener);
  });
});

describe("hydratePage — hydration error hooks handed to hydrateRoot", () => {
  it("wires onRecoverableError/onCaughtError/onUncaughtError, each reporting once", () => {
    installFakeDocument();
    const callback = vi.fn();
    onClientError(callback);

    hydratePage(() => "tree");

    const options = vi.mocked(hydrateRoot).mock.calls[0]?.[2] as {
      onRecoverableError: (error: unknown) => void;
      onCaughtError: (error: unknown) => void;
      onUncaughtError: (error: unknown) => void;
    };

    expect(options).toBeDefined();

    const recoverable = new Error("recoverable");
    const caught = new Error("caught");
    const uncaught = new Error("uncaught");

    options.onRecoverableError(recoverable);
    options.onCaughtError(caught);
    options.onUncaughtError(uncaught);

    expect(callback).toHaveBeenCalledTimes(3);
    const kinds = callback.mock.calls.map(([event]) => (event as ClientErrorEvent).kind);
    expect(kinds).toEqual(["hydration", "boundary", "hydration"]);
    const errors = callback.mock.calls.map(([event]) => (event as ClientErrorEvent).error);
    expect(errors).toEqual([recoverable, caught, uncaught]);
  });
});
