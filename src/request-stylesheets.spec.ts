import { describe, expect, it } from "vitest";
import {
  InvalidStylesheetSourceError,
  linkStylesheetsFor,
  requestStylesheetSources,
} from "./request-stylesheets";

describe("linkStylesheetsFor — per-request stylesheet declarations", () => {
  it("records declared source modules on the request, in declaration order, deduped", () => {
    const request = {};

    linkStylesheetsFor(request, "src/web/themes/alpha/alpha-theme.tsx");
    linkStylesheetsFor(request, "src/web/widgets/banner.tsx");
    linkStylesheetsFor(request, "src/web/themes/alpha/alpha-theme.tsx");

    expect(requestStylesheetSources(request)).toEqual([
      "src/web/themes/alpha/alpha-theme.tsx",
      "src/web/widgets/banner.tsx",
    ]);
  });

  it("never lets one request see another request's declarations", () => {
    const alphaRequest = {};
    const betaRequest = {};

    linkStylesheetsFor(alphaRequest, "src/web/themes/alpha/alpha-theme.tsx");
    linkStylesheetsFor(betaRequest, "src/web/themes/beta/beta-theme.tsx");

    expect(requestStylesheetSources(alphaRequest)).toEqual([
      "src/web/themes/alpha/alpha-theme.tsx",
    ]);
    expect(requestStylesheetSources(betaRequest)).toEqual(["src/web/themes/beta/beta-theme.tsx"]);
  });

  it("answers an empty list for a request that declared nothing", () => {
    expect(requestStylesheetSources({})).toEqual([]);
  });

  it.each([
    ["an empty id", ""],
    ["an absolute path", "/src/web/theme.tsx"],
    ["a Windows absolute path", "C:/app/src/web/theme.tsx"],
    ["a parent segment", "src/web/../../secrets.tsx"],
    ["a leading ./", "./themes/alpha.tsx"],
    ["a backslash", "src\\web\\theme.tsx"],
    ["a query", "src/web/theme.css?inline"],
  ])("rejects %s, naming the value", (_label, sourceFile) => {
    expect(() => linkStylesheetsFor({}, sourceFile)).toThrow(InvalidStylesheetSourceError);
    expect(() => linkStylesheetsFor({}, sourceFile)).toThrow(JSON.stringify(sourceFile));
  });
});
