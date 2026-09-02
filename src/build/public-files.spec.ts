import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPublicFiles, copyPublicFiles } from "./public-files";

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("production public files", () => {
  it("collects and copies the app public tree with stable POSIX paths", async () => {
    const source = temporaryDirectory("warlock-public-source-");
    const output = temporaryDirectory("warlock-public-output-");

    fs.mkdirSync(path.join(source, "images"), { recursive: true });
    fs.writeFileSync(path.join(source, "favicon.svg"), "<svg />", "utf-8");
    fs.writeFileSync(path.join(source, "images", "logo.txt"), "logo", "utf-8");

    const files = await collectPublicFiles(source);
    await copyPublicFiles(source, output, files);

    expect(files).toEqual(["favicon.svg", "images/logo.txt"]);
    expect(fs.readFileSync(path.join(output, "favicon.svg"), "utf-8")).toBe("<svg />");
    expect(fs.readFileSync(path.join(output, "images", "logo.txt"), "utf-8")).toBe("logo");
  });

  it("treats a missing public directory as an empty public surface", async () => {
    const root = temporaryDirectory("warlock-public-missing-");

    await expect(collectPublicFiles(path.join(root, "public"))).resolves.toEqual([]);
  });
});
