import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishRouteTable } from "../routing/route-table";
import { writeCurrentRouteTypes } from "./write-current-route-types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
  publishRouteTable([], "test cleanup");
});

describe("writeCurrentRouteTypes", () => {
  it("uses the installed page table rather than rediscovering page modules", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-current-route-types-"));
    temporaryDirectories.push(appRoot);
    publishRouteTable([{ name: "blog.show", path: "/blog/:slug" }], "connector");

    await writeCurrentRouteTypes({
      appRoot,
      apis: [{ name: "comments.create", path: "/comments", method: "POST" }],
    });

    const output = fs.readFileSync(path.join(appRoot, ".warlock/typings/web-routes.d.ts"), "utf8");
    expect(output).toContain('"blog.show"');
    expect(output).toContain('"comments.create"');
  });
});
