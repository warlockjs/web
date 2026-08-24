import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRouterEvents,
  routerEvents,
  type NavigationEndPayload,
  type NavigationErrorPayload,
  type NavigationStartPayload,
} from "./router-events";

const start = (url: string): NavigationStartPayload => ({ url, mode: "push" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscribe -> emit -> the listener receives the right payload", () => {
  it("delivers the navigating payload verbatim", () => {
    const events = createRouterEvents();
    const listener = vi.fn();

    events.onNavigating(listener);
    events.emitNavigating({ url: "/settings", mode: "push" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ url: "/settings", mode: "push" });
  });

  it("delivers the navigated payload verbatim, resolved URL included", () => {
    // `resolvedUrl` is not the same string as `url` whenever the server
    // redirected — fetch-page-data.ts returns the URL the response actually
    // came from for exactly that reason, and a listener must be able to see
    // both without doing any parsing of its own.
    const events = createRouterEvents();
    const listener = vi.fn();
    const payload: NavigationEndPayload = {
      url: "/settings",
      resolvedUrl: "/login",
      mode: "push",
    };

    events.onNavigated(listener);
    events.emitNavigated(payload);

    expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("delivers the navigation-error payload verbatim", () => {
    const events = createRouterEvents();
    const listener = vi.fn();
    const error = new Error("chunk load failed");
    const payload: NavigationErrorPayload = { url: "/settings", mode: "replace", error };

    events.onNavigationError(listener);
    events.emitNavigationError(payload);

    expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("keeps the three events separate — emitting one notifies only its own listeners", () => {
    const events = createRouterEvents();
    const navigating = vi.fn();
    const navigated = vi.fn();
    const failed = vi.fn();

    events.onNavigating(navigating);
    events.onNavigated(navigated);
    events.onNavigationError(failed);

    events.emitNavigating(start("/a"));

    expect(navigating).toHaveBeenCalledTimes(1);
    expect(navigated).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("notifies every listener of the same event, in subscription order", () => {
    const events = createRouterEvents();
    const calls: string[] = [];

    events.onNavigating(() => calls.push("first"));
    events.onNavigating(() => calls.push("second"));
    events.emitNavigating(start("/a"));

    expect(calls).toEqual(["first", "second"]);
  });

  it("emits to nobody without throwing when nothing is subscribed", () => {
    const events = createRouterEvents();

    expect(() => events.emitNavigating(start("/a"))).not.toThrow();
  });
});

describe("unsubscribe actually stops delivery", () => {
  it("stops delivering to a listener that unsubscribed", () => {
    const events = createRouterEvents();
    const listener = vi.fn();

    const unsubscribe = events.onNavigating(listener);

    events.emitNavigating(start("/a"));
    unsubscribe();
    events.emitNavigating(start("/b"));

    expect(listener).toHaveBeenCalledExactlyOnceWith({ url: "/a", mode: "push" });
  });

  it("returns an unsubscribe function from every subscribe call", () => {
    const events = createRouterEvents();

    expect(typeof events.onNavigating(vi.fn())).toBe("function");
    expect(typeof events.onNavigated(vi.fn())).toBe("function");
    expect(typeof events.onNavigationError(vi.fn())).toBe("function");
  });

  it("is idempotent — unsubscribing twice is not an error and does not free a re-subscription", () => {
    // A progress bar in React StrictMode runs its effect cleanup twice; the
    // second call must be a no-op rather than removing a listener registered
    // by the re-run effect.
    const events = createRouterEvents();
    const listener = vi.fn();

    const unsubscribe = events.onNavigating(listener);

    unsubscribe();
    unsubscribe();
    events.onNavigating(listener);
    events.emitNavigating(start("/a"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes only the listener it belongs to", () => {
    const events = createRouterEvents();
    const kept = vi.fn();
    const dropped = vi.fn();

    events.onNavigating(kept);
    events.onNavigating(dropped)();
    events.emitNavigating(start("/a"));

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("delivers to the same callback once per subscription, and each unsubscribe drops one", () => {
    // The same function object subscribed twice is two registrations, not one
    // — a Set keyed by the callback would silently collapse them and then let
    // a single cleanup kill a listener another component still wants.
    const events = createRouterEvents();
    const listener = vi.fn();

    const first = events.onNavigating(listener);

    events.onNavigating(listener);
    events.emitNavigating(start("/a"));

    expect(listener).toHaveBeenCalledTimes(2);

    listener.mockClear();
    first();
    events.emitNavigating(start("/b"));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not deliver to a listener unsubscribed by an earlier listener during the same emit", () => {
    const events = createRouterEvents();
    const later = vi.fn();

    events.onNavigating(() => unsubscribeLater());

    const unsubscribeLater = events.onNavigated(later);

    events.onNavigating(() => events.emitNavigated({ url: "/a", resolvedUrl: "/a", mode: "push" }));
    events.emitNavigating(start("/a"));

    expect(later).not.toHaveBeenCalled();
  });

  it("does not notify a listener subscribed during the emit that is already running", () => {
    // Iterating a snapshot: a listener added mid-emit belongs to the NEXT
    // navigation, and mutating the live registration list under the loop is
    // how an emitter starts skipping listeners.
    const events = createRouterEvents();
    const lateComer = vi.fn();

    events.onNavigating(() => {
      events.onNavigating(lateComer);
    });

    events.emitNavigating(start("/a"));

    expect(lateComer).not.toHaveBeenCalled();

    events.emitNavigating(start("/b"));

    expect(lateComer).toHaveBeenCalledTimes(1);
  });
});

describe("a throwing listener must not break the emit loop", () => {
  it("still notifies the listeners after the one that threw", () => {
    // THE ONE THAT MATTERS: one bad progress-bar listener must not kill
    // navigation. Everything downstream of the emit — history, the tree swap —
    // runs after this loop returns.
    const events = createRouterEvents();
    const before = vi.fn();
    const after = vi.fn();

    vi.spyOn(console, "error").mockImplementation(() => {});

    events.onNavigating(before);
    events.onNavigating(() => {
      throw new Error("bad progress bar");
    });
    events.onNavigating(after);

    expect(() => events.emitNavigating(start("/a"))).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("reports the listener failure rather than swallowing it silently", () => {
    const events = createRouterEvents();
    const error = new Error("bad progress bar");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    events.onNavigating(() => {
      throw error;
    });
    events.emitNavigating(start("/a"));

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toContain(error);
  });

  it("survives a listener that throws a non-Error value", () => {
    const events = createRouterEvents();
    const after = vi.fn();

    vi.spyOn(console, "error").mockImplementation(() => {});

    events.onNavigating(() => {
      // Not an Error on purpose: `catch` binds whatever was thrown, and an
      // emitter that assumed `.message` would itself throw inside the handler
      // meant to contain the failure.
      throw "a string";
    });
    events.onNavigating(after);

    expect(() => events.emitNavigating(start("/a"))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("keeps a throwing listener subscribed — one bad emit is not a deregistration", () => {
    const events = createRouterEvents();
    const listener = vi.fn(() => {
      throw new Error("every time");
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    events.onNavigating(listener);
    events.emitNavigating(start("/a"));
    events.emitNavigating(start("/b"));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("isolates a throwing error-listener too, so a failed navigation still finishes reporting", () => {
    const events = createRouterEvents();
    const after = vi.fn();

    vi.spyOn(console, "error").mockImplementation(() => {});

    events.onNavigationError(() => {
      throw new Error("bad handler");
    });
    events.onNavigationError(after);

    const payload: NavigationErrorPayload = {
      url: "/a",
      mode: "push",
      error: new Error("original"),
    };

    expect(() => events.emitNavigationError(payload)).not.toThrow();
    expect(after).toHaveBeenCalledExactlyOnceWith(payload);
  });
});

describe("importing the module in a non-browser context does not throw", () => {
  it("runs under a suite with no `window` at all", () => {
    // The suite's environment is `node` (vitest.config.ts), so this assertion
    // is what makes every other test in this file a server-side test: the
    // module was imported, `routerEvents` was constructed, and neither touched
    // a DOM global.
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("re-imports cold with the module registry reset, still without a DOM", async () => {
    vi.resetModules();

    const fresh = await import("./router-events");

    expect(fresh.routerEvents).toBeDefined();
    expect(typeof fresh.createRouterEvents).toBe("function");
  });

  it("subscribes and emits on the server without throwing", () => {
    // Nothing subscribes during an SSR render today, but the module must not
    // become the reason a server render dies if something ever does.
    const listener = vi.fn();
    const unsubscribe = routerEvents.onNavigating(listener);

    expect(() => routerEvents.emitNavigating(start("/a"))).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe("the shared singleton", () => {
  it("is one instance — every import of the module gets the same registrations", async () => {
    // Two imports rather than a comparison against the top-level binding: an
    // earlier test in this file calls `vi.resetModules()`, so the binding this
    // file imported statically is from the registry that existed before the
    // reset. That is a vitest artifact and says nothing about production. What
    // does say something is that within ONE module registry the singleton is
    // resolved once and shared, which is what these two imports assert.
    const [first, second] = await Promise.all([
      import("./router-events"),
      import("./router-events"),
    ]);

    expect(first.routerEvents).toBe(second.routerEvents);
  });

  it("is independent of any instance handed out by createRouterEvents", () => {
    const events = createRouterEvents();
    const onSingleton = vi.fn();
    const onInstance = vi.fn();

    const unsubscribe = routerEvents.onNavigating(onSingleton);

    events.onNavigating(onInstance);
    events.emitNavigating(start("/a"));

    expect(onInstance).toHaveBeenCalledTimes(1);
    expect(onSingleton).not.toHaveBeenCalled();

    unsubscribe();
  });
});
