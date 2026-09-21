import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeRouteLocales } from "./serialize-route-locales";

const temporaryDirectories: string[] = [];

function fixture(
  relative: string,
  source: string,
): { appRoot: string; sourceFile: string; webRoot: string } {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-route-locales-"));
  temporaryDirectories.push(appRoot);
  const sourceFile = path.join(appRoot, relative);
  const webRoot = path.join(appRoot, "src", "web");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, source, "utf-8");
  return { appRoot, sourceFile, webRoot };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("serializeRouteLocales", () => {
  it("validates source-only locale JSON and retains verbatim app-relative artifacts", () => {
    const source = '{\n  "title": { "en": "Title", "pt-BR": "Título" }\n}\n';
    const file = fixture("src/web/products/(private)/locales.json", source);

    expect(
      serializeRouteLocales([{ sourceFile: file.sourceFile, webRoot: file.webRoot }], file.appRoot),
    ).toEqual([
      {
        sourceFile: "src/web/products/(private)/locales.json",
        webRoot: "src/web",
        source,
      },
    ]);
  });

  it("refuses malformed source before emitting a production artifact", () => {
    const file = fixture("src/web/locales.json", '{"title":{"en_US":"Title"}}');

    expect(() =>
      serializeRouteLocales([{ sourceFile: file.sourceFile, webRoot: file.webRoot }], file.appRoot),
    ).toThrow(/invalid locale code/);
  });
});
