import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import {
  InvalidProductionPublicFileError,
  MissingProductionPublicFileError,
  registerProductionPublicFiles,
} from "./register-production-public-files";

const temporaryDirectories: string[] = [];

function clientDirectory(files: Record<string, string>): string {
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-client-public-"));
  temporaryDirectories.push(clientDir);

  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(clientDir, "public", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf-8");
  }

  return clientDir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("registerProductionPublicFiles", () => {
  it("registers exact root URLs without mounting the client or manifest directories", () => {
    const clientDir = clientDirectory({
      "favicon.svg": "<svg />",
      "docs/rem-public.txt": "public",
    });
    const file = vi.fn();

    registerProductionPublicFiles(
      { file } as unknown as Router,
      clientDir,
      ["favicon.svg", "docs/rem-public.txt"],
    );

    expect(file).toHaveBeenCalledTimes(2);
    expect(file).toHaveBeenNthCalledWith(
      1,
      "/favicon.svg",
      path.join(clientDir, "public", "favicon.svg"),
      300,
    );
    expect(file).toHaveBeenNthCalledWith(
      2,
      "/docs/rem-public.txt",
      path.join(clientDir, "public", "docs", "rem-public.txt"),
      300,
    );
  });

  it("fails loudly when a successful-build manifest names a missing file", () => {
    const clientDir = clientDirectory({});

    expect(() =>
      registerProductionPublicFiles({ file: vi.fn() } as unknown as Router, clientDir, [
        "favicon.svg",
      ]),
    ).toThrow(MissingProductionPublicFileError);
  });

  it("refuses traversal and native-separator paths from a malformed manifest", () => {
    const clientDir = clientDirectory({});
    const router = { file: vi.fn() } as unknown as Router;

    expect(() => registerProductionPublicFiles(router, clientDir, ["../secret"])).toThrow(
      InvalidProductionPublicFileError,
    );
    expect(() => registerProductionPublicFiles(router, clientDir, ["images\\logo.svg"])).toThrow(
      InvalidProductionPublicFileError,
    );
  });
});
