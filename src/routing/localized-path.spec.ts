import { afterEach, describe, expect, it } from "vitest";
import { localizedPath } from "./localized-path";
import { publishLocaleRouting } from "./locale-routing";

describe("localizedPath", () => {
  afterEach(() => publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" }));

  it("prefixes a non-default locale under prefix-except-default", () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    expect(localizedPath("/posts/x", "ar")).toBe("/ar/posts/x");
    expect(localizedPath("/", "ar")).toBe("/ar");
  });

  it("leaves the default locale bare under prefix-except-default", () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    expect(localizedPath("/posts/x", "en")).toBe("/posts/x");
  });

  it("prefixes every locale under prefix", () => {
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    expect(localizedPath("/posts/x", "en")).toBe("/en/posts/x");
  });

  it("returns the path unchanged when locale routing is off", () => {
    expect(localizedPath("/posts/x", "ar")).toBe("/posts/x");
  });
});
