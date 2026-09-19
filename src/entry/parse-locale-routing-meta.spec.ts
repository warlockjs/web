import { describe, expect, it } from "vitest";
import { parseLocaleRoutingMeta } from "./parse-locale-routing-meta";

describe("parseLocaleRoutingMeta", () => {
  it("parses a valid strategy=none payload", () => {
    expect(parseLocaleRoutingMeta('{"strategy":"none","codes":[],"defaultLocale":""}')).toEqual({
      strategy: "none",
      codes: [],
      defaultLocale: "",
    });
  });

  it("parses a valid prefix-except-default payload", () => {
    expect(
      parseLocaleRoutingMeta(
        '{"strategy":"prefix-except-default","codes":["en","ar"],"defaultLocale":"en"}',
      ),
    ).toEqual({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
  });

  it("returns undefined for missing content", () => {
    expect(parseLocaleRoutingMeta(undefined)).toBeUndefined();
    expect(parseLocaleRoutingMeta(null)).toBeUndefined();
    expect(parseLocaleRoutingMeta("")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseLocaleRoutingMeta("{not json")).toBeUndefined();
  });

  it("returns undefined for a JSON array", () => {
    expect(parseLocaleRoutingMeta("[]")).toBeUndefined();
  });

  it("returns undefined for a JSON primitive", () => {
    expect(parseLocaleRoutingMeta("42")).toBeUndefined();
    expect(parseLocaleRoutingMeta('"prefix"')).toBeUndefined();
    expect(parseLocaleRoutingMeta("null")).toBeUndefined();
  });

  it("returns undefined for an invalid strategy", () => {
    expect(
      parseLocaleRoutingMeta('{"strategy":"bogus","codes":[],"defaultLocale":""}'),
    ).toBeUndefined();
  });

  it("returns undefined when strategy is missing", () => {
    expect(parseLocaleRoutingMeta('{"codes":[],"defaultLocale":""}')).toBeUndefined();
  });

  it("returns undefined when codes is not a string array", () => {
    expect(
      parseLocaleRoutingMeta('{"strategy":"prefix","codes":[1,2],"defaultLocale":"en"}'),
    ).toBeUndefined();
    expect(
      parseLocaleRoutingMeta('{"strategy":"prefix","codes":"en","defaultLocale":"en"}'),
    ).toBeUndefined();
  });

  it("returns undefined when defaultLocale is not a string", () => {
    expect(
      parseLocaleRoutingMeta('{"strategy":"prefix","codes":["en"],"defaultLocale":null}'),
    ).toBeUndefined();
  });

  it("returns undefined for an object missing required keys entirely", () => {
    expect(parseLocaleRoutingMeta("{}")).toBeUndefined();
  });
});
