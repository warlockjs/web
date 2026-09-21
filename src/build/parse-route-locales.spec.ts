import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRouteLocaleFile, RouteLocaleFileError } from "./parse-route-locales";

const webRoot = path.join("C:", "app", "src", "web");
const locales = ["en", "ar"] as const;

function parse(source: string, directory = "products/(private)/[id]") {
  return parseRouteLocaleFile({
    sourceFile: path.join(webRoot, directory, "locales.json"),
    webRoot,
    source,
    localeCodes: locales,
  });
}

describe("parseRouteLocaleFile", () => {
  it("derives a full static namespace and expands nested entry keys", () => {
    expect(
      parse(
        JSON.stringify({
          title: { en: "Products", ar: "المنتجات" },
          card: { add: { en: "Add", ar: "أضف" } },
        }),
      ),
    ).toEqual({
      sourceFile: path.join(webRoot, "products/(private)/[id]", "locales.json"),
      webRoot,
      group: "products",
      entries: {
        "products.title": { en: "Products", ar: "المنتجات" },
        "products.card.add": { en: "Add", ar: "أضف" },
      },
    });
  });

  it("allows an empty root without a group", () => {
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "locales.json"),
        webRoot,
        source: "{}",
        localeCodes: locales,
      }),
    ).toMatchObject({
      group: "",
      entries: {},
    });
  });

  it("finishes parsing an empty root at end-of-file", () => {
    expect(parse("{}", "")).toMatchObject({ group: "", entries: {} });
  });

  it("derives a static folder prefix when $group is absent", () => {
    expect(parse('{"email":{"en":"Email","ar":"البريد"}}', "users")).toMatchObject({
      group: "users",
      entries: { "users.email": { en: "Email", ar: "البريد" } },
    });
  });

  it("collects source-only leaves while validating generic locale-code and string shapes", () => {
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "products", "locales.json"),
        webRoot,
        source: '{"title":{"en":"Title","pt-BR":"Título"}}',
      }),
    ).toMatchObject({
      entries: { "products.title": { en: "Title", "pt-BR": "Título" } },
    });

    expect(() =>
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "products", "locales.json"),
        webRoot,
        source: '{"$group":"products","title":{"en_US":"Title"}}',
      }),
    ).toThrow(/invalid locale code/);
  });

  it("uses an explicit group instead of the folder prefix", () => {
    expect(
      parse('{"$group":"account.settings","email":{"en":"Email","ar":"البريد"}}', "users"),
    ).toMatchObject({
      group: "account.settings",
      entries: { "account.settings.email": { en: "Email", ar: "البريد" } },
    });
  });

  it("lets an explicit group replace an otherwise invalid folder prefix", () => {
    expect(
      parse('{"$group":"account","email":{"en":"Email","ar":"البريد"}}', "users.v2"),
    ).toMatchObject({
      group: "account",
    });
  });

  it("refuses an explicit group when the file is outside the web root", () => {
    expect(() =>
      parseRouteLocaleFile({
        sourceFile: path.join("C:", "outside", "locales.json"),
        webRoot,
        source: '{"$group":"account","email":{"en":"Email","ar":"البريد"}}',
        localeCodes: locales,
      }),
    ).toThrow(/outside the web root/);
  });

  it("uses no prefix for a non-empty root file without $group", () => {
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "locales.json"),
        webRoot,
        source: '{"shared":{"en":"Shared","ar":"مشترك"}}',
        localeCodes: locales,
      }),
    ).toMatchObject({ group: "", entries: { shared: { en: "Shared", ar: "مشترك" } } });
  });

  it.each([
    ["empty group", '{"$group":"","title":{"en":"Title","ar":"العنوان"}}', /cannot be empty/],
    [
      "empty group segment",
      '{"$group":"products..card","title":{"en":"Title","ar":"العنوان"}}',
      /empty segments/,
    ],
    [
      "reserved group segment",
      '{"$group":"products.prototype","title":{"en":"Title","ar":"العنوان"}}',
      /reserved/,
    ],
    ["dotted key", '{"$group":"products","a.b":{"en":"Title","ar":"العنوان"}}', /cannot contain/],
    ["reserved key", '{"$group":"products","__proto__":{"en":"Title","ar":"العنوان"}}', /reserved/],
    ["nested group", '{"$group":"products","card":{"$group":"card"}}', /only allowed at the root/],
    ["empty nested object", '{"$group":"products","card":{}}', /cannot be empty/],
    [
      "unknown locale",
      '{"$group":"products","title":{"en":"Title","fr":"Titre"}}',
      /unknown locale code/,
    ],
    ["missing locale", '{"$group":"products","title":{"en":"Title"}}', /missing locale/],
    [
      "mixed nesting",
      '{"$group":"products","card":{"en":"Card","title":{"en":"Title","ar":"العنوان"}}}',
      /cannot mix/,
    ],
    [
      "duplicate escaped key",
      '{"title":{"en":"A","\\u0065n":"B","ar":"العنوان"}}',
      /duplicate JSON property/,
    ],
    ["trailing comma", '{"title":{"en":"A","ar":"ب"},}', /object keys must be JSON strings/],
    [
      "non-JSON whitespace",
      '{\u00a0"title":{"en":"A","ar":"ب"}}',
      /object keys must be JSON strings/,
    ],
  ])("refuses %s with the file and key in its diagnostic", (_name, source, message) => {
    expect(() => parse(source)).toThrow(RouteLocaleFileError);
    expect(() => parse(source)).toThrow(message);
    expect(() => parse(source)).toThrow(/locales\.json/);
  });
});
