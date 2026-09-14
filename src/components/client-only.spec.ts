// @vitest-environment jsdom
import { act, createElement, lazy, Suspense } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientOnly } from "./client-only";

let container: HTMLDivElement | undefined;

/** Required by React 19's `act()` to recognize this as a testing environment. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe("ClientOnly — server render", () => {
  it("renders the fallback and never the children", () => {
    const html = renderToString(
      createElement(ClientOnly, {
        fallback: createElement("p", null, "loading"),
        children: createElement("p", null, "client"),
      }),
    );

    expect(html).toContain("loading");
    expect(html).not.toContain("client");
  });

  it("renders nothing when no fallback is given", () => {
    const html = renderToString(
      createElement(ClientOnly, { children: createElement("p", null, "client") }),
    );

    expect(html).toBe("");
  });

  it("never calls function children", () => {
    const children = vi.fn(() => createElement("p", null, "client"));

    renderToString(
      createElement(ClientOnly, { fallback: createElement("p", null, "loading"), children }),
    );

    expect(children).not.toHaveBeenCalled();
  });

  it("never imports a React.lazy module reached only through its children", async () => {
    const importModule = vi.fn(async () => ({
      default: () => createElement("p", null, "lazy loaded"),
    }));
    const LazyWidget = lazy(importModule);

    renderToString(
      createElement(ClientOnly, {
        fallback: createElement("p", null, "loading"),
        children: createElement(Suspense, { fallback: null }, createElement(LazyWidget)),
      }),
    );

    expect(importModule).not.toHaveBeenCalled();
  });
});

describe("ClientOnly — hydration and mount", () => {
  it("hydrates without a mismatch and swaps to children after mount", () => {
    const tree = () =>
      createElement(ClientOnly, {
        fallback: createElement("p", null, "loading"),
        children: createElement("p", null, "client"),
      });

    const html = renderToString(tree());

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    expect(container.textContent).toBe("loading");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() => {
      hydrateRoot(container as HTMLDivElement, tree());
    });

    expect(consoleError).not.toHaveBeenCalled();
    expect(container.textContent).toBe("client");
  });

  it("calls function children only after mount", () => {
    const children = vi.fn(() => createElement("p", null, "client"));
    const tree = () =>
      createElement(ClientOnly, { fallback: createElement("p", null, "loading"), children });

    const html = renderToString(tree());

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    expect(children).not.toHaveBeenCalled();

    act(() => {
      hydrateRoot(container as HTMLDivElement, tree());
    });

    expect(children).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("client");
  });
});
