// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/navigation/fetch-page-data", () => ({
  fetchPageData: vi.fn(async () => ({ type: "payload", payload: {} })),
}));

import { installSession, resetSession, SessionContext, useUser } from "./use-user";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  resetSession();
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));

  return container;
}

const label = (user: unknown) => (user === null ? "guest" : String((user as { id: unknown }).id));

/** The plain hook: follows the store, guest included. */
function Plain() {
  return createElement("span", null, label(useUser()));
}

/** The opted-in hook: the route name is the opt-in. */
function Retained() {
  // The registry has no generated guarded names here, so the name is cast for the test only.
  return createElement("span", null, label(useUser("account.show" as never)));
}

describe("useUser(name) retains the last signed-in user", () => {
  it("keeps the last non-null user after the store goes to a guest", () => {
    installSession({ user: { id: 7 } });
    const view = mount(createElement(Retained));
    expect(view.textContent).toBe("7");

    act(() => installSession(undefined));

    expect(view.textContent).toBe("7");
  });

  it("follows a different signed-in user and retains the newest one", () => {
    installSession({ user: { id: 1 } });
    const view = mount(createElement(Retained));

    act(() => installSession({ user: { id: 2 } }));
    expect(view.textContent).toBe("2");

    act(() => installSession(undefined));
    expect(view.textContent).toBe("2");
  });

  it("does not change the plain useUser(): it still reports the guest", () => {
    installSession({ user: { id: 7 } });
    const view = mount(createElement(Plain));
    expect(view.textContent).toBe("7");

    act(() => installSession(undefined));

    expect(view.textContent).toBe("guest");
  });

  it("scopes retention to the mounted component, not the process", () => {
    installSession({ user: { id: 7 } });
    mount(createElement(Retained));
    act(() => root?.unmount());
    act(() => installSession(undefined));

    const view = mount(createElement(Retained));

    expect(view.textContent).toBe("guest");
  });

  it("retains through a server-render provider going null as well", () => {
    const tree = (user: { id: number } | null) =>
      createElement(SessionContext.Provider, { value: { user } }, createElement(Retained));
    const view = mount(tree({ id: 9 }));
    expect(view.textContent).toBe("9");

    act(() => root?.render(tree(null)));

    expect(view.textContent).toBe("9");
  });
});
