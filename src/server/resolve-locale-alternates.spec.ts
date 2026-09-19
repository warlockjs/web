import { describe, expect, it } from "vitest";
import type { LocaleRouting } from "../routing/locale-routing";
import { resolveDocumentLocaleRouting, resolveLocaleAlternates } from "./resolve-locale-alternates";

const ORIGIN = "https://app.test";

const prefixExceptDefault: LocaleRouting = {
  strategy: "prefix-except-default",
  codes: ["en", "ar"],
  defaultLocale: "en",
};

const prefix: LocaleRouting = {
  strategy: "prefix",
  codes: ["en", "ar"],
  defaultLocale: "en",
};

const none: LocaleRouting = { strategy: "none", codes: [], defaultLocale: "" };

// `:locale`-folder routes are locale-routed with no config (design note §C.1) —
// `app.localeCodes`/`app.localeCode` are still populated even though the
// strategy itself is "none" (`resolveLocaleRouting()` reads them
// unconditionally).
const noneWithCodes: LocaleRouting = { strategy: "none", codes: ["en", "ar"], defaultLocale: "en" };

describe("resolveLocaleAlternates — prefix-except-default", () => {
  it("emits en bare, ar prefixed, and x-default bare for the default-locale request", () => {
    const alternates = resolveLocaleAlternates(
      "/posts/x",
      "/posts/:id",
      prefixExceptDefault,
      ORIGIN,
    );

    expect(alternates).toEqual([
      { hreflang: "en", href: "https://app.test/posts/x" },
      { hreflang: "ar", href: "https://app.test/ar/posts/x" },
      { hreflang: "x-default", href: "https://app.test/posts/x" },
    ]);
  });

  it("resolves the same alternates from the ar-prefixed request itself", () => {
    const alternates = resolveLocaleAlternates(
      "/ar/posts/x",
      "/ar/posts/:id",
      prefixExceptDefault,
      ORIGIN,
    );

    expect(alternates).toEqual([
      { hreflang: "en", href: "https://app.test/posts/x" },
      { hreflang: "ar", href: "https://app.test/ar/posts/x" },
      { hreflang: "x-default", href: "https://app.test/posts/x" },
    ]);
  });
});

describe("resolveLocaleAlternates — prefix", () => {
  it("prefixes every code, including the default, and x-default follows the default", () => {
    const alternates = resolveLocaleAlternates("/en/posts/x", "/en/posts/:id", prefix, ORIGIN);

    expect(alternates).toEqual([
      { hreflang: "en", href: "https://app.test/en/posts/x" },
      { hreflang: "ar", href: "https://app.test/ar/posts/x" },
      { hreflang: "x-default", href: "https://app.test/en/posts/x" },
    ]);
  });
});

describe("resolveLocaleAlternates — a :locale-folder route", () => {
  it("prefixes every code, including the default, even when the global strategy is none", () => {
    const alternates = resolveLocaleAlternates(
      "/ar/posts/x",
      "/:locale/posts/:id",
      noneWithCodes,
      ORIGIN,
    );

    expect(alternates).toEqual([
      { hreflang: "en", href: "https://app.test/en/posts/x" },
      { hreflang: "ar", href: "https://app.test/ar/posts/x" },
      { hreflang: "x-default", href: "https://app.test/en/posts/x" },
    ]);
  });
});

describe("resolveLocaleAlternates — strategy none, no :locale route", () => {
  it("emits no alternates with no configured codes", () => {
    const alternates = resolveLocaleAlternates("/posts/x", "/posts/:id", none, ORIGIN);

    expect(alternates).toBeUndefined();
  });

  it("emits no alternates even with codes configured — today's behaviour is unchanged", () => {
    const alternates = resolveLocaleAlternates("/posts/x", "/posts/:id", noneWithCodes, ORIGIN);

    expect(alternates).toBeUndefined();
  });
});

describe("resolveLocaleAlternates — missing origin", () => {
  it("emits nothing when there is no configured public URL", () => {
    const alternates = resolveLocaleAlternates(
      "/posts/x",
      "/posts/:id",
      prefixExceptDefault,
      undefined,
    );

    expect(alternates).toBeUndefined();
  });
});

describe("resolveDocumentLocaleRouting", () => {
  it("returns the routing table as-is under an active strategy", () => {
    expect(resolveDocumentLocaleRouting("/posts/:id", prefixExceptDefault)).toEqual(
      prefixExceptDefault,
    );
    expect(resolveDocumentLocaleRouting("/posts/:id", prefix)).toEqual(prefix);
  });

  it("returns undefined for strategy none on a non-:locale route", () => {
    expect(resolveDocumentLocaleRouting("/posts/:id", none)).toBeUndefined();
    expect(resolveDocumentLocaleRouting("/posts/:id", noneWithCodes)).toBeUndefined();
  });

  it("returns the routing table for strategy none on a :locale-folder route", () => {
    expect(resolveDocumentLocaleRouting("/:locale/about", noneWithCodes)).toEqual(noneWithCodes);
    expect(resolveDocumentLocaleRouting("/:locale", noneWithCodes)).toEqual(noneWithCodes);
  });

  it("needs no origin, unlike resolveLocaleAlternates", () => {
    expect(resolveDocumentLocaleRouting("/posts/:id", prefixExceptDefault)).toEqual(
      prefixExceptDefault,
    );
  });
});
