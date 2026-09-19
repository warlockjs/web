import { describe, expect, it } from "vitest";
import { localePrefixedPaths } from "./locale-prefixed-paths";
import type { LocaleRouting } from "./locale-routing";

const NONE: LocaleRouting = { strategy: "none", codes: [], defaultLocale: "" };
const PREFIX: LocaleRouting = { strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" };
const PREFIX_EXCEPT_DEFAULT: LocaleRouting = {
  strategy: "prefix-except-default",
  codes: ["en", "ar"],
  defaultLocale: "en",
};

describe("localePrefixedPaths — none", () => {
  it("returns nothing under strategy none", () => {
    expect(localePrefixedPaths("/posts", NONE)).toEqual([]);
    expect(localePrefixedPaths("/", NONE)).toEqual([]);
  });
});

describe("localePrefixedPaths — root", () => {
  it("prefixes the root path without a trailing slash", () => {
    expect(localePrefixedPaths("/", PREFIX)).toEqual([
      { path: "/en", locale: "en" },
      { path: "/ar", locale: "ar" },
    ]);
  });
});

describe("localePrefixedPaths — nested", () => {
  it("prefixes a nested path", () => {
    expect(localePrefixedPaths("/posts/:slug", PREFIX)).toEqual([
      { path: "/en/posts/:slug", locale: "en" },
      { path: "/ar/posts/:slug", locale: "ar" },
    ]);
  });
});

describe("localePrefixedPaths — prefix vs prefix-except-default", () => {
  it("prefix registers every code, including the default", () => {
    expect(localePrefixedPaths("/posts", PREFIX)).toEqual([
      { path: "/en/posts", locale: "en" },
      { path: "/ar/posts", locale: "ar" },
    ]);
  });

  it("prefix-except-default omits the default locale — it stays on the base registration", () => {
    expect(localePrefixedPaths("/posts", PREFIX_EXCEPT_DEFAULT)).toEqual([
      { path: "/ar/posts", locale: "ar" },
    ]);
  });
});
