// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetScrollPositions, saveScrollPosition } from "./scroll-positions";
import {
  applyScrollPosition,
  captureScrollPosition,
  decideNewNavigationScroll,
  decidePopStateScroll,
  installManualScrollRestoration,
  resetManualScrollRestorationInstalled,
  scrollToTop,
} from "./scroll-restoration";

/**
 * The POLICY this module owns — see its header. Every claim `navigation-root`
 * relies on for scroll behaviour is provable here without mounting React:
 * a new navigation scrolls to top unless the URL has a hash, and a
 * Back/Forward move restores a saved position even OVER a hash.
 */

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
});

afterEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
  vi.restoreAllMocks();
});

describe("decideNewNavigationScroll — a <Link> click or navigateTo()", () => {
  it("scrolls to top when the URL has no hash", () => {
    expect(decideNewNavigationScroll(undefined)).toEqual({ type: "top" });
  });

  it("defers to the fragment when the URL has a hash", () => {
    expect(decideNewNavigationScroll("reviews")).toEqual({
      type: "fragment",
      fragment: "reviews",
    });
  });
});

describe("decidePopStateScroll — Back/Forward", () => {
  it("restores the saved position when one exists, hash or not", () => {
    saveScrollPosition("entry-1", { x: 0, y: 400 });

    expect(decidePopStateScroll("entry-1", undefined)).toEqual({
      type: "restore",
      position: { x: 0, y: 400 },
    });
  });

  /**
   * THE CLAIM THIS CARD OWNS: a saved position beats a hash on Back/Forward.
   * The hash names where the user first arrived; the saved position names
   * where they had since scrolled to, and "go back" means the latter.
   */
  it("prefers the saved position over the URL's hash", () => {
    saveScrollPosition("entry-1", { x: 0, y: 777 });

    expect(decidePopStateScroll("entry-1", "reviews")).toEqual({
      type: "restore",
      position: { x: 0, y: 777 },
    });
  });

  it("falls back to the fragment when nothing was saved for the entry", () => {
    expect(decidePopStateScroll("never-visited", "reviews")).toEqual({
      type: "fragment",
      fragment: "reviews",
    });
  });

  it("falls back to the top when nothing was saved and there is no hash", () => {
    expect(decidePopStateScroll("never-visited", undefined)).toEqual({ type: "top" });
  });
});

describe("installManualScrollRestoration", () => {
  it("sets history.scrollRestoration to manual", () => {
    const history = { scrollRestoration: "auto" as ScrollRestoration };

    installManualScrollRestoration(history);

    expect(history.scrollRestoration).toBe("manual");
  });

  it("is a no-op the second time it is called", () => {
    const history = { scrollRestoration: "auto" as ScrollRestoration };

    installManualScrollRestoration(history);
    history.scrollRestoration = "auto";
    installManualScrollRestoration(history);

    // The guard fired, so the second call never touched the property again —
    // proven by it staying "auto" after we set it back ourselves.
    expect(history.scrollRestoration).toBe("auto");
  });

  it("never throws even when the property assignment does", () => {
    const history = {
      get scrollRestoration(): ScrollRestoration {
        return "auto";
      },
      set scrollRestoration(_value: ScrollRestoration) {
        throw new Error("unsupported");
      },
    };

    expect(() => installManualScrollRestoration(history)).not.toThrow();
  });
});

describe("the DOM primitives", () => {
  it("captureScrollPosition saves window.scrollX/scrollY under the given key", () => {
    Object.defineProperty(window, "scrollX", { value: 12, configurable: true });
    Object.defineProperty(window, "scrollY", { value: 340, configurable: true });

    captureScrollPosition("entry-1");

    expect(decidePopStateScroll("entry-1", undefined)).toEqual({
      type: "restore",
      position: { x: 12, y: 340 },
    });
  });

  it("scrollToTop calls window.scrollTo(0, 0)", () => {
    const spy = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    scrollToTop();

    expect(spy).toHaveBeenCalledWith(0, 0);
  });

  it("applyScrollPosition calls window.scrollTo with the saved coordinates", () => {
    const spy = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    applyScrollPosition({ x: 5, y: 900 });

    expect(spy).toHaveBeenCalledWith(5, 900);
  });
});
