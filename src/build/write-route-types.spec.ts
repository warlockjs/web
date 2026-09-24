import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRouteTypes } from "./write-route-types";

const temporaryDirectories: string[] = [];

function temporaryApp(): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-route-types-"));
  temporaryDirectories.push(appRoot);
  return appRoot;
}

function targetFor(appRoot: string): string {
  return path.join(appRoot, ".warlock", "typings", "web-routes.d.ts");
}

afterEach(() => {
  while (temporaryDirectories.length > 0)
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe("writeRouteTypes", () => {
  it("atomically replaces stale declarations, including with an empty snapshot", async () => {
    const appRoot = temporaryApp();
    const first = await writeRouteTypes({
      appRoot,
      pages: [{ name: "posts.show", path: "/posts/:id", method: "GET" }],
      apis: [],
    });
    const second = await writeRouteTypes({ appRoot, pages: [], apis: [] });

    expect(first.changed).toBe(true);
    expect(second).toEqual({ path: targetFor(appRoot), changed: true });
    expect(fs.readFileSync(targetFor(appRoot), "utf-8")).not.toContain('"posts.show"');
  });

  it("does not replace an identical declaration", async () => {
    const appRoot = temporaryApp();
    const input = {
      appRoot,
      pages: [{ name: "posts.show", path: "/posts/:id", method: "GET" }],
      apis: [],
    };

    await writeRouteTypes(input);
    await expect(writeRouteTypes(input)).resolves.toEqual({
      path: targetFor(appRoot),
      changed: false,
    });
  });

  it("cleans up only its temporary sibling after replacement fails", async () => {
    const appRoot = temporaryApp();
    const target = targetFor(appRoot);
    fs.mkdirSync(target, { recursive: true });

    await expect(writeRouteTypes({ appRoot, pages: [], apis: [] })).rejects.toBeDefined();

    const siblings = fs
      .readdirSync(path.dirname(target))
      .filter((name) => name.startsWith(".web-routes."));
    expect(siblings).toEqual([]);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });
});
