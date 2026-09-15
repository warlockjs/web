// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScrollPosition,
  hydrateScrollPositions,
  resetScrollPositions,
  saveScrollPosition,
} from "./scroll-positions";

/**
 * The `Map` + `sessionStorage` store scroll restoration keys every position
 * by an entry (see `history-entry-key.ts` for why it is not the URL).
 *
 * ## Why a throwing `sessionStorage` getter is the one scenario this file
 * exists to prove
 *
 * A private-browsing tab in some engines makes the `window.sessionStorage`
 * PROPERTY itself throw on read, not merely the calls made on it. Wrapping
 * only `.getItem`/`.setItem` in `try`/`catch` would still crash the first time
 * this module reaches for the property, and a scroll-position feature that
 * can crash a navigation is strictly worse than no feature at all — hence
 * every access goes through `readSessionStorage()`, and this suite proves
 * that with a real throwing getter rather than a mocked `Storage` object.
 */

beforeEach(() => {
  resetScrollPositions();
});

afterEach(() => {
  resetScrollPositions();
  vi.restoreAllMocks();
});

describe("scroll-positions — the happy path", () => {
  it("returns undefined for a key nothing was ever saved under", () => {
    expect(getScrollPosition("unknown")).toBeUndefined();
  });

  it("returns exactly what was saved for a key", () => {
    saveScrollPosition("entry-1", { x: 0, y: 240 });

    expect(getScrollPosition("entry-1")).toEqual({ x: 0, y: 240 });
  });

  it("keeps positions for different entries apart", () => {
    saveScrollPosition("entry-1", { x: 0, y: 100 });
    saveScrollPosition("entry-2", { x: 0, y: 900 });

    expect(getScrollPosition("entry-1")).toEqual({ x: 0, y: 100 });
    expect(getScrollPosition("entry-2")).toEqual({ x: 0, y: 900 });
  });

  it("overwrites a position saved again for the same entry", () => {
    saveScrollPosition("entry-1", { x: 0, y: 100 });
    saveScrollPosition("entry-1", { x: 0, y: 250 });

    expect(getScrollPosition("entry-1")).toEqual({ x: 0, y: 250 });
  });
});

describe("scroll-positions — sessionStorage persistence", () => {
  it("survives a reload by hydrating from sessionStorage", () => {
    saveScrollPosition("entry-1", { x: 10, y: 500 });

    // Simulate a reload: the in-memory Map is gone, but the module has not
    // been re-imported, so the persistence path is proven by resetting only
    // the Map and re-hydrating from the (real) sessionStorage underneath it.
    resetScrollPositions();
    hydrateScrollPositions();

    expect(getScrollPosition("entry-1")).toEqual({ x: 10, y: 500 });
  });

  it("hydrates only once — a later save is not overwritten by a stale hydrate", () => {
    saveScrollPosition("entry-1", { x: 0, y: 1 });
    hydrateScrollPositions();

    window.sessionStorage.setItem(
      "warlock:scroll-positions",
      JSON.stringify({ "entry-1": { x: 0, y: 999 } }),
    );

    hydrateScrollPositions();

    expect(getScrollPosition("entry-1")).toEqual({ x: 0, y: 1 });
  });
});

describe("scroll-positions — a failing sessionStorage never breaks the feature", () => {
  it("still saves and reads in memory when the sessionStorage getter throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");

    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    try {
      expect(() => saveScrollPosition("entry-1", { x: 0, y: 42 })).not.toThrow();
      expect(getScrollPosition("entry-1")).toEqual({ x: 0, y: 42 });

      resetScrollPositions();
      expect(() => hydrateScrollPositions()).not.toThrow();
      expect(getScrollPosition("entry-1")).toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(window, "sessionStorage", descriptor);
    }
  });

  it("recovers from corrupt JSON left in sessionStorage", () => {
    window.sessionStorage.setItem("warlock:scroll-positions", "{not json");

    expect(() => hydrateScrollPositions()).not.toThrow();
    expect(getScrollPosition("entry-1")).toBeUndefined();
  });
});
