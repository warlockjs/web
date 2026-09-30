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
