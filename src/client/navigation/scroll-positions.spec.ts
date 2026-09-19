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

describe("scroll-positions — capped at 50 entries with LRU eviction", () => {
  it("keeps only the newest 50 of 60 saves, evicting the oldest 10", () => {
    for (let i = 0; i < 60; i++) {
      saveScrollPosition(`entry-${i}`, { x: 0, y: i });
    }

    for (let i = 0; i < 10; i++) {
      expect(getScrollPosition(`entry-${i}`)).toBeUndefined();
    }

    for (let i = 10; i < 60; i++) {
      expect(getScrollPosition(`entry-${i}`)).toEqual({ x: 0, y: i });
    }
  });

  it("a touched old entry survives eviction", () => {
    for (let i = 0; i < 49; i++) {
      saveScrollPosition(`entry-${i}`, { x: 0, y: i });
    }

    // entry-0 is the oldest so far; touch it via a read so it becomes
    // most-recently-used before the map is pushed past capacity.
    expect(getScrollPosition("entry-0")).toEqual({ x: 0, y: 0 });

    for (let i = 49; i < 60; i++) {
      saveScrollPosition(`entry-${i}`, { x: 0, y: i });
    }

    expect(getScrollPosition("entry-0")).toEqual({ x: 0, y: 0 });
  });

  it("keeps sessionStorage at at most 50 entries", () => {
    for (let i = 0; i < 60; i++) {
      saveScrollPosition(`entry-${i}`, { x: 0, y: i });
    }

    const raw = window.sessionStorage.getItem("warlock:scroll-positions");

    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw as string) as Record<string, unknown>;

    expect(Object.keys(parsed)).toHaveLength(50);
  });

  it("reads an oversized legacy sessionStorage value, and trims it on the next write", () => {
    const legacy: Record<string, { x: number; y: number }> = {};

    for (let i = 0; i < 80; i++) {
      legacy[`entry-${i}`] = { x: 0, y: i };
    }

    window.sessionStorage.setItem("warlock:scroll-positions", JSON.stringify(legacy));

    expect(() => hydrateScrollPositions()).not.toThrow();

    // Reading works: the most recently written legacy entries are there.
    expect(getScrollPosition("entry-79")).toEqual({ x: 0, y: 79 });

    // sessionStorage itself still holds the untouched legacy blob until the
    // next write.
    const beforeWrite = JSON.parse(
      window.sessionStorage.getItem("warlock:scroll-positions") as string,
    ) as Record<string, unknown>;

    expect(Object.keys(beforeWrite)).toHaveLength(80);

    saveScrollPosition("entry-new", { x: 0, y: 999 });

    const afterWrite = JSON.parse(
      window.sessionStorage.getItem("warlock:scroll-positions") as string,
    ) as Record<string, unknown>;

    expect(Object.keys(afterWrite)).toHaveLength(50);
  });
});
