import config from "@mongez/config";
import { afterEach, describe, expect, it } from "vitest";
import { LocaleRoutingConfigError, resolveLocaleRouting } from "./resolve-locale-routing";

afterEach(() => {
  config.set("web", {});
  config.set("app", {});
});

describe("resolveLocaleRouting — defaults", () => {
  it("defaults the strategy to none with no app locale config", () => {
    expect(resolveLocaleRouting()).toEqual({ strategy: "none", codes: [], defaultLocale: "" });
  });

  it("reads codes from app.localeCodes and the default from app.localeCode under none", () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    expect(resolveLocaleRouting()).toEqual({
      strategy: "none",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
  });

  it("resolves a valid non-none strategy against app.localeCodes / app.localeCode", () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    expect(resolveLocaleRouting()).toEqual({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
  });
});

describe("resolveLocaleRouting — invalid strategy", () => {
  it("throws a clear config error for an unknown strategy value", () => {
    config.set("web", { localeRouting: { strategy: "bogus" } });

    expect(() => resolveLocaleRouting()).toThrow(LocaleRoutingConfigError);
    expect(() => resolveLocaleRouting()).toThrow(/localeRouting\.strategy/);
  });
});

describe("resolveLocaleRouting — default not in codes", () => {
  it("throws when a non-none strategy has fewer than one code", () => {
    config.set("web", { localeRouting: { strategy: "prefix" } });
    config.set("app", { localeCodes: [], localeCode: "en" });

    expect(() => resolveLocaleRouting()).toThrow(LocaleRoutingConfigError);
  });

  it("throws when app.localeCode is not one of app.localeCodes", () => {
    config.set("web", { localeRouting: { strategy: "prefix" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "fr" });

    expect(() => resolveLocaleRouting()).toThrow(LocaleRoutingConfigError);
  });
});
