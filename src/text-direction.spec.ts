import { afterEach, describe, expect, it, vi } from "vitest";
import { localeDirection } from "./text-direction";

/**
 * Every (locale, expected direction) pair the resolver must agree on,
 * whether it answers from `Intl.Locale`'s own text info or falls back to
 * the script/language table.
 */
const CASES: ReadonlyArray<[locale: string, expected: "rtl" | "ltr"]> = [
  ["ar", "rtl"],
  ["he", "rtl"],
  ["fa", "rtl"],
  ["ur", "rtl"],
  ["ar-EG", "rtl"],
  ["en", "ltr"],
  ["en-US", "ltr"],
  ["zh-Hant", "ltr"],
  ["ja", "ltr"],
  ["az-Arab", "rtl"],
  ["ku-Latn", "ltr"],
  ["", "ltr"],
  ["not a locale!!", "ltr"],
];

describe("localeDirection", () => {
  it.each(CASES)(
    "resolves %s to %s via the runtime's own Intl.Locale text info",
    (locale, expected) => {
      expect(localeDirection(locale)).toBe(expected);
    },
  );
});

describe("localeDirection (Intl.Locale text info stubbed out)", () => {
  const getTextInfoDescriptor = Object.getOwnPropertyDescriptor(
    Intl.Locale.prototype,
    "getTextInfo",
  );
  const textInfoDescriptor = Object.getOwnPropertyDescriptor(Intl.Locale.prototype, "textInfo");

  afterEach(() => {
    if (getTextInfoDescriptor) {
      Object.defineProperty(Intl.Locale.prototype, "getTextInfo", getTextInfoDescriptor);
    }
    if (textInfoDescriptor) {
      Object.defineProperty(Intl.Locale.prototype, "textInfo", textInfoDescriptor);
    }
    vi.restoreAllMocks();
  });

  it.each(CASES)(
    "falls back to the script/language table and still resolves %s to %s",
    (locale, expected) => {
      // Simulate a runtime that exposes neither the `getTextInfo()` method
      // nor the `textInfo` getter, forcing the script/language table.
      delete Intl.Locale.prototype.getTextInfo;
      delete (Intl.Locale.prototype as { textInfo?: unknown }).textInfo;

      expect(localeDirection(locale)).toBe(expected);
    },
  );
});
