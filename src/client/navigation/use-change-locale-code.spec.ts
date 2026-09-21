// @vitest-environment jsdom
import { act, createElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const changeLocaleCode = vi.fn<(code: string) => Promise<void>>();

vi.mock("./change-locale-code", () => ({
  changeLocaleCode: (code: string) => changeLocaleCode(code),
}));

const { useChangeLocaleCode } = await import("./use-change-locale-code");

/**
 * Driven with the same harness the rest of this package uses —
 * `react-dom/client` + React's own `act`, no testing-library. Matching the
 * surrounding shape matters more than convenience here: a spec that pulls in a
 * dependency the package does not have is a spec that cannot run.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A promise this test settles by hand, so the in-flight window can be observed. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });

  return { promise, resolve, reject };
}

type HookHandle = {
  current: ReturnType<typeof useChangeLocaleCode>;
  /** Re-renders the SAME component type, so the hook instance survives. */
  rerender: () => void;
};

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

/** Mounts a probe that publishes the hook's latest return value. */
function mountHook(): HookHandle {
  const handle = {
    current: undefined as unknown as ReturnType<typeof useChangeLocaleCode>,
    rerender: () => undefined as void,
  };

  // Declared ONCE, outside any re-render. Rendering a freshly-declared
  // function component is a different element TYPE as far as React is
  // concerned, so it remounts and the hook starts over — which looks exactly
  // like an unstable callback identity and is not.
  function Probe(): ReactElement | null {
    handle.current = useChangeLocaleCode();
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);

  const root = createRoot(container);
  roots.push(root);

  act(() => {
    root.render(createElement(Probe));
  });

  handle.rerender = () => {
    act(() => {
      root.render(createElement(Probe));
    });
  };

  return handle;
}

beforeEach(() => {
  changeLocaleCode.mockReset();
  changeLocaleCode.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });

  for (const container of containers.splice(0)) container.remove();
});

describe("useChangeLocaleCode", () => {
  it("is not loading before anything is asked of it", () => {
    const hook = mountHook();

    expect(hook.current.isLoading).toBe(false);
  });

  it("passes the code straight through to changeLocaleCode", async () => {
    const hook = mountHook();

    await act(async () => {
      await hook.current.changeLocale("ar");
    });

    expect(changeLocaleCode).toHaveBeenCalledWith("ar");
    expect(hook.current.changeLocaleCode).toBe(hook.current.changeLocale);
  });

  it("reports isLoading for exactly the window the switch is in flight", async () => {
    const inFlight = deferred();
    changeLocaleCode.mockReturnValue(inFlight.promise);

    const hook = mountHook();

    act(() => {
      void hook.current.changeLocale("ar");
    });

    expect(hook.current.isLoading).toBe(true);

    await act(async () => {
      inFlight.resolve();
      await inFlight.promise;
    });

    expect(hook.current.isLoading).toBe(false);
  });

  it("CLEARS isLoading when the switch fails — the control the user needs to retry", async () => {
    // The failure this guards: a rejected switch leaving the picker disabled
    // forever, so the one button that would let the user try again is the one
    // that stopped working.
    changeLocaleCode.mockRejectedValue(new Error("network"));

    const hook = mountHook();

    await act(async () => {
      await expect(hook.current.changeLocale("ar")).rejects.toThrow("network");
    });

    expect(hook.current.isLoading).toBe(false);
  });

  it("REJECTS rather than swallowing the failure", async () => {
    // A swallowed rejection means the user clicks Arabic, the page stays
    // English, and nothing anywhere says why.
    changeLocaleCode.mockRejectedValue(new Error("network"));

    const hook = mountHook();

    await act(async () => {
      await expect(hook.current.changeLocale("ar")).rejects.toThrow("network");
    });
  });

  it("keeps each hook instance's loading state to itself", async () => {
    // Two pickers on one page: using the header one must not light up the
    // footer one, which would be a lie about what the user did.
    const inFlight = deferred();
    changeLocaleCode.mockReturnValue(inFlight.promise);

    const header = mountHook();
    const footer = mountHook();

    act(() => {
      void header.current.changeLocale("ar");
    });

    expect(header.current.isLoading).toBe(true);
    expect(footer.current.isLoading).toBe(false);

    await act(async () => {
      inFlight.resolve();
      await inFlight.promise;
    });
  });

  it.each(["older first", "newer first"])(
    "keeps loading for the latest overlapping invocation when %s settles",
    async (settlement) => {
      const first = deferred();
      const second = deferred();
      changeLocaleCode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const hook = mountHook();

      act(() => {
        void hook.current.changeLocaleCode("ar");
        void hook.current.changeLocaleCode("fr");
      });
      expect(hook.current.isLoading).toBe(true);

      const firstToSettle = settlement === "older first" ? first : second;
      const secondToSettle = settlement === "older first" ? second : first;
      await act(async () => {
        firstToSettle.resolve();
        await firstToSettle.promise;
      });
      expect(hook.current.isLoading).toBe(settlement === "older first");

      await act(async () => {
        secondToSettle.resolve();
        await secondToSettle.promise;
      });
      expect(hook.current.isLoading).toBe(false);
    },
  );

  it("does not let an older rejection clear a newer pending invocation", async () => {
    const older = deferred();
    const newer = deferred();
    changeLocaleCode.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const hook = mountHook();

    act(() => {
      void hook.current.changeLocaleCode("ar").catch(() => undefined);
      void hook.current.changeLocaleCode("fr");
    });
    await act(async () => {
      older.reject(new Error("older failed"));
      await older.promise.catch(() => undefined);
    });
    expect(hook.current.isLoading).toBe(true);

    await act(async () => {
      newer.resolve();
      await newer.promise;
    });
    expect(hook.current.isLoading).toBe(false);
  });

  it("does not warn when the switch settles after unmount", async () => {
    const inFlight = deferred();
    changeLocaleCode.mockReturnValue(inFlight.promise);

    const hook = mountHook();

    act(() => {
      void hook.current.changeLocale("ar");
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });

    await act(async () => {
      inFlight.resolve();
      await inFlight.promise;
    });

    // A user who switches locale and immediately navigates away is doing
    // nothing wrong, and should not be told otherwise in the console.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps a stable changeLocale identity across renders", () => {
    // A picker passing this to a memoised child should not re-render it on
    // every parent render.
    const hook = mountHook();
    const first = hook.current.changeLocale;

    hook.rerender();

    expect(hook.current.changeLocale).toBe(first);
    expect(hook.current.changeLocaleCode).toBe(first);
  });

  it("clears a current invocation after StrictMode's effect rehearsal", async () => {
    const inFlight = deferred();
    changeLocaleCode.mockReturnValue(inFlight.promise);
    const handle = { current: undefined as unknown as ReturnType<typeof useChangeLocaleCode> };
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(() => {
            handle.current = useChangeLocaleCode();
            return null;
          }),
        ),
      );
    });
    act(() => {
      void handle.current.changeLocaleCode("ar");
    });
    await act(async () => {
      inFlight.resolve();
      await inFlight.promise;
    });

    expect(handle.current.isLoading).toBe(false);
  });
});
