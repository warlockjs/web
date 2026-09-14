// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsClient } from "./use-is-client";

/**
 * `useIsClient` must return the SAME value on the server render and on the
 * client's hydration render — that is the whole point of it — so this suite
 * proves both ends: a plain server render never sees `true`, and a real
 * `hydrateRoot` pass over that exact server markup neither warns about a
 * mismatch nor leaves the value stuck at `false` once mounted.
 */

function Probe(): string {
  const isClient = useIsClient();
  return isClient ? "client" : "server";
}

let container: HTMLDivElement | undefined;

/** Required by React 19's `act()` to recognize this as a testing environment. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  container?.remove();
  container = undefined;
});

describe("useIsClient", () => {
  it("is false during a server render", () => {
    const html = renderToString(createElement(Probe));

    expect(html).toBe("server");
  });

  it("is false on the hydration render and true after mount, with no hydration mismatch", () => {
    const html = renderToString(createElement(Probe));

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() => {
      hydrateRoot(container as HTMLDivElement, createElement(Probe));
    });

    expect(consoleError).not.toHaveBeenCalled();
    expect(container.textContent).toBe("client");
  });
});
