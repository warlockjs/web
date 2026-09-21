import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRouteLocaleKeys } from "./list-route-locale-keys";

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-locale-keys-"));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, "utf-8");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("listRouteLocaleKeys", () => {
  it("unions physical namespaces and explicit groups without reading application modules", () => {
    const appRoot = fixture({
      "src/config/app.ts": 'throw new Error("configuration must not execute");',
      "src/web/index.page.tsx": "this is deliberately invalid TypeScript",
      "src/web/locales.json": '{"welcome":{"en":"Welcome","ar":"مرحبا"}}',
      "src/web/account/(private)/[id]/locales.json": '{"save":{"en":"Save"}}',
      "src/web/orphan/locales.json": '{"$group":"profile","title":{"en":"Profile"}}',
      "src/app/legacy/web/locales.json": '{"ignored":{"en":"Ignored"}}',
    });
    expect(listRouteLocaleKeys({ appRoot })).toEqual(["account.save", "profile.title", "welcome"]);
  });

  it("reflects additions, group edits, and deletion on subsequent generation", () => {
    const appRoot = fixture({});
    expect(listRouteLocaleKeys({ appRoot })).toEqual([]);
    const sourceFile = path.join(appRoot, "src/web/locales.json");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, '{"$group":"first","key":{"en":"Value"}}', "utf-8");
    expect(listRouteLocaleKeys({ appRoot })).toEqual(["first.key"]);
    fs.writeFileSync(sourceFile, '{"$group":"second","key":{"en":"Value"}}', "utf-8");
    expect(listRouteLocaleKeys({ appRoot })).toEqual(["second.key"]);
    fs.unlinkSync(sourceFile);
    expect(listRouteLocaleKeys({ appRoot })).toEqual([]);
  });

  it("rejects collisions across routes before emitting types", () => {
    const appRoot = fixture({
      "src/web/a/locales.json": '{"$group":"shared","title":{"en":"A"}}',
      "src/web/b/locales.json": '{"$group":"shared","title":{"en":"B"}}',
    });
    expect(() => listRouteLocaleKeys({ appRoot })).toThrow(/declared by both/);
  });

  it("rejects malformed locale source even without a page", () => {
    const appRoot = fixture({ "src/web/locales.json": '{"title":{"en":123}}' });
    expect(() => listRouteLocaleKeys({ appRoot })).toThrow();
  });

  it("honors a custom source directory", () => {
    const appRoot = fixture({ "source/web/locales.json": '{"title":{"en":"Title"}}' });
    expect(listRouteLocaleKeys({ appRoot, srcDir: "source" })).toEqual(["title"]);
  });
});
