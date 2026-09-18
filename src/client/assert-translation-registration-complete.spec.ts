import { extend } from "@mongez/localization";
import { describe, expect, it } from "vitest";
import {
  IncompleteTranslationRegistrationError,
  assertTranslationRegistrationComplete,
} from "./assert-translation-registration-complete";

/**
 * `@mongez/localization`'s table is a module-level singleton, so every case
 * below `extend()`s a locale code unique to that case rather than resetting
 * shared state between tests.
 */
let localeCounter = 0;
function freshLocale(): string {
  localeCounter += 1;

  return `test-locale-${localeCounter}`;
}

describe("assertTranslationRegistrationComplete", () => {
  it("passes when every required key is already registered for the locale", () => {
    const locale = freshLocale();
    extend(locale, { home: { title: "Home" } });

    expect(() =>
      assertTranslationRegistrationComplete("main.home", locale, { home: { title: "Home" } }),
    ).not.toThrow();
  });

  it("passes trivially when the page requires no translations", () => {
    const locale = freshLocale();

    expect(() => assertTranslationRegistrationComplete("main.home", locale, {})).not.toThrow();
  });

  it("throws, naming the page and locale, when nothing was registered for a required namespace", () => {
    const locale = freshLocale();

    let failure: unknown;

    try {
      assertTranslationRegistrationComplete("main.home", locale, { home: { title: "Home" } });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(IncompleteTranslationRegistrationError);
    const error = failure as IncompleteTranslationRegistrationError;
    expect(error.pageName).toBe("main.home");
    expect(error.locale).toBe(locale);
    expect(error.missingKeys).toEqual(["home"]);
    expect(error.message).toContain('"main.home"');
    expect(error.message).toContain(JSON.stringify(locale));
    expect(error.message).toContain('"home"');
  });

  it("names the nested dotted path when only a nested keyword is missing", () => {
    const locale = freshLocale();
    extend(locale, { home: {} });

    let failure: unknown;

    try {
      assertTranslationRegistrationComplete("main.home", locale, {
        home: { title: "Home", subtitle: "Welcome" },
      });
    } catch (error) {
      failure = error;
    }

    expect((failure as IncompleteTranslationRegistrationError).missingKeys).toEqual([
      "home.title",
      "home.subtitle",
    ]);
  });

  it("is scoped to the required locale — a sibling locale's registration does not count", () => {
    const locale = freshLocale();
    const otherLocale = freshLocale();
    extend(otherLocale, { home: { title: "Accueil" } });

    expect(() =>
      assertTranslationRegistrationComplete("main.home", locale, { home: { title: "Home" } }),
    ).toThrow(IncompleteTranslationRegistrationError);
  });

  it("treats a required namespace registered as a plain string, not an object, as missing", () => {
    const locale = freshLocale();
    extend(locale, { home: "not a namespace" as unknown as Record<string, string> });

    let failure: unknown;

    try {
      assertTranslationRegistrationComplete("main.home", locale, { home: { title: "Home" } });
    } catch (error) {
      failure = error;
    }

    expect((failure as IncompleteTranslationRegistrationError).missingKeys).toEqual(["home"]);
  });
});
