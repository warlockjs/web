// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  createEntryKey,
  ensureEntryKey,
  readEntryKey,
  withEntryKey,
} from "./history-entry-key";

/**
 * Every history entry the client router touches needs an identity that
 * outlives its URL — see this module's header for why. These specs prove the
 * three guarantees that identity depends on: a key is read back exactly, an
 * entry with no key gets one WITHOUT losing other state already there, and
 * `ensureEntryKey` never mints a second key for an entry that already has one.
 */

beforeEach(() => {
  history.replaceState(null, "");
});

describe("readEntryKey / withEntryKey", () => {
  it("reads undefined from state with no key", () => {
    expect(readEntryKey(null)).toBeUndefined();
    expect(readEntryKey(undefined)).toBeUndefined();
    expect(readEntryKey({ other: 1 })).toBeUndefined();
  });

  it("reads back a key written by withEntryKey", () => {
    const state = withEntryKey(null, "abc");

    expect(readEntryKey(state)).toBe("abc");
  });

  it("preserves existing fields when adding a key", () => {
    const state = withEntryKey({ scrollX: 1, form: "draft" }, "abc");

    expect(state).toEqual({ scrollX: 1, form: "draft", __warlockScrollKey: "abc" });
  });

  it("overwrites only the key field when one is already present", () => {
    const first = withEntryKey({ note: "kept" }, "old-key");
    const second = withEntryKey(first, "new-key");

    expect(readEntryKey(second)).toBe("new-key");
    expect(second).toMatchObject({ note: "kept" });
  });
});

describe("createEntryKey", () => {
  it("mints a different key on every call", () => {
    const a = createEntryKey();
    const b = createEntryKey();

    expect(a).not.toBe(b);
  });
});

describe("ensureEntryKey", () => {
  it("mints and writes a key via replaceState when the entry has none", () => {
    expect(history.state).toBeNull();

    const key = ensureEntryKey(history);

    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
    expect(readEntryKey(history.state)).toBe(key);
  });

  it("returns the SAME key on a later call rather than minting a new one", () => {
    const first = ensureEntryKey(history);
    const second = ensureEntryKey(history);

    expect(second).toBe(first);
  });

  it("preserves other state already on the entry", () => {
    history.replaceState({ scrollX: 5 }, "");

    const key = ensureEntryKey(history);

    expect(history.state).toEqual({ scrollX: 5, __warlockScrollKey: key });
  });

  it("does not touch the URL", () => {
    history.replaceState(null, "", "/products?page=2");

    const before = window.location.href;

    ensureEntryKey(history);

    expect(window.location.href).toBe(before);
  });
});
