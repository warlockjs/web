// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Image } from "./image";
import type { ImageDescriptor } from "./types";

/**
 * `jsdom` gives `hydrateRoot` a live DOM to mount into — the same reason
 * `client-only.spec.ts` isolates its hydration cases into a live-DOM
 * environment. Whether the SSR STRING itself matches production content is
 * covered separately in `image.spec.ts`'s plain `node` environment (see that
 * file's header): `jsdom` resolves `react-dom/server` to a different build
 * than production SSR does, so this file asserts only on the hydration
 * OUTCOME (no console.error), never on markup content.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

const baseImage: ImageDescriptor = {
  src: "/uploads/posts/cover.jpg",
  width: 1600,
  height: 900,
  variants: {
    large: { width: 1200 },
    small: { width: 400 },
    medium: { width: 800 },
  },
};

describe("Image — SSR/hydration parity", () => {
  it("hydrates the SSR markup with no hydration warnings, lazy example", () => {
    const tree = () => createElement(Image, { image: baseImage, alt: "hydrated" });
    const html = renderToString(tree());

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() => {
      hydrateRoot(container as HTMLDivElement, tree());
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("hydrates the SSR markup with no hydration warnings, priority example with formats", () => {
    const image: ImageDescriptor = { ...baseImage, formats: ["avif", "webp"] };
    const tree = () => createElement(Image, { image, alt: "hydrated priority", priority: true });
    const html = renderToString(tree());

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() => {
      hydrateRoot(container as HTMLDivElement, tree());
    });

    expect(consoleError).not.toHaveBeenCalled();
  });
});
