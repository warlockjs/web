import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRouteLocaleFile, RouteLocaleFileError } from "./parse-route-locales";

const webRoot = path.join("C:", "app", "src", "web");
const locales = ["en", "ar"] as const;

describe("parseRouteLocaleFile", () => {
  it("derives a static directory namespace and ignores route-only directories", () => {
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "products", "(private)", "[id]", "locales.json"),
        webRoot,
        source: '{"title":{"en":"Products","ar":"المنتجات"}}',
        localeCodes: locales,
      }),
    ).toMatchObject({
      group: "products",
      entries: { "products.title": { en: "Products", ar: "المنتجات" } },
    });
  });

  it("uses a declared $group without deriving a namespace from $-prefixed folders", () => {
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "$sites", "my-site", "$auth", "account", "locales.json"),
        webRoot,
        source: '{"$group":"account","title":{"en":"Account","ar":"الحساب"}}',
        localeCodes: locales,
      }),
    ).toMatchObject({ group: "account", entries: { "account.title": { en: "Account", ar: "الحساب" } } });
  });

  it("skips $sites/<site> and other $-prefixed folders when deriving the namespace", () => {
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "$sites", "my-site", "$auth", "account", "locales.json"),
        webRoot,
        source: '{"title":{"en":"Account","ar":"الحساب"}}',
        localeCodes: locales,
      }),
    ).toMatchObject({ group: "account", entries: { "account.title": { en: "Account", ar: "الحساب" } } });
  });

  it("does not derive a namespace at all when $group is declared", () => {
    // `my site` is not a valid namespace segment; it must not matter when `$group` names the group.
    expect(
      parseRouteLocaleFile({
        sourceFile: path.join(webRoot, "my site", "locales.json"),
        webRoot,
        source: '{"$group":"home","title":{"en":"Home","ar":"الرئيسية"}}',
        localeCodes: locales,
      }).group,
    ).toBe("home");
  });

  it("keeps the core parser error identity and byte-identical diagnostic", () => {
    const sourceFile = path.join(webRoot, "products", "locales.json");
    const message = `Cannot parse route locales in "${sourceFile}" at "products.title": missing locale code "ar".`;
    expect(() =>
      parseRouteLocaleFile({
        sourceFile,
        webRoot,
        source: '{"title":{"en":"Title"}}',
        localeCodes: locales,
      }),
    ).toThrow(RouteLocaleFileError);
    expect(() =>
      parseRouteLocaleFile({
        sourceFile,
        webRoot,
        source: '{"title":{"en":"Title"}}',
        localeCodes: locales,
      }),
    ).toThrow(message);
  });

  it("retains the web-root boundary diagnostic", () => {
    const sourceFile = path.join("C:", "outside", "locales.json");
    expect(() =>
      parseRouteLocaleFile({ sourceFile, webRoot, source: "{}", localeCodes: locales }),
    ).toThrow(
      `Cannot parse route locales in "${sourceFile}" at "$": file is outside the web root.`,
    );
  });
});
