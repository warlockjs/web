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

    registerProductionPublicFiles({ file } as unknown as Router, clientDir, [
      "favicon.svg",
      "docs/rem-public.txt",
    ]);

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

  it("stays silent when disk matches the manifest exactly", () => {
    const clientDir = clientDirectory({ "favicon.svg": "<svg />" });
    const warn = vi.fn();

    registerProductionPublicFiles(
      { file: vi.fn() } as unknown as Router,
      clientDir,
      ["favicon.svg"],
      warn,
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when there is no public directory at all", () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-client-public-"));
    temporaryDirectories.push(clientDir);
    const warn = vi.fn();

    registerProductionPublicFiles({ file: vi.fn() } as unknown as Router, clientDir, [], warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it("names a file added to public/ after the build, without failing to boot", () => {
    const clientDir = clientDirectory({
      "favicon.svg": "<svg />",
      "docs/new-report.pdf": "pdf",
    });
    const warn = vi.fn();

    registerProductionPublicFiles(
      { file: vi.fn() } as unknown as Router,
      clientDir,
      ["favicon.svg"],
      warn,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("public/ is stale");
    expect(message).toContain("docs/new-report.pdf");
    expect(message).toContain("404");
    expect(message).toContain("warlock build");
  });

  /*
   * `web-connector.ts:431` used to call this function only when
   * `pageManifest.publicFiles.length > 0`, so a build that captured ZERO
   * public files never reached the staleness check at all — the exact case a
   * build-time snapshot is most likely to miss on the very next file drop.
   * These three cases are the red control that fix relies on: GUILTY names a
   * file the empty manifest cannot know about, and the two INNOCENT cases
   * prove the fix does not turn "no public/ files" into false positives.
   */
  describe("empty manifest — the case the removed length guard used to skip", () => {
    it("GUILTY: an empty manifest still names a file present on disk", () => {
      const clientDir = clientDirectory({ "logo.svg": "<svg />" });
      const warn = vi.fn();

      registerProductionPublicFiles({ file: vi.fn() } as unknown as Router, clientDir, [], warn);

      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain("public/ is stale");
      expect(message).toContain("logo.svg");
    });

    it("INNOCENT: an empty manifest with an existing, empty public/ directory stays silent", () => {
      const clientDir = clientDirectory({});
      fs.mkdirSync(path.join(clientDir, "public"), { recursive: true });
      const warn = vi.fn();

      registerProductionPublicFiles({ file: vi.fn() } as unknown as Router, clientDir, [], warn);

      expect(warn).not.toHaveBeenCalled();
    });

    it("INNOCENT: an empty manifest with no public/ directory at all stays silent — the ordinary no-public-directory case, not staleness", () => {
      const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-client-public-"));
      temporaryDirectories.push(clientDir);
      const warn = vi.fn();

      registerProductionPublicFiles({ file: vi.fn() } as unknown as Router, clientDir, [], warn);

      expect(warn).not.toHaveBeenCalled();
    });

    it("THE DEFECT RETURNING: gating the call on publicFiles.length (the removed guard) hides the GUILTY case", () => {
      const clientDir = clientDirectory({ "logo.svg": "<svg />" });
      const warn = vi.fn();
      const publicFiles: string[] = [];

      // Mirrors the exact conditional removed from `web-connector.ts:431-438`.
      if (publicFiles.length > 0) {
        registerProductionPublicFiles(
          { file: vi.fn() } as unknown as Router,
          clientDir,
          publicFiles,
          warn,
        );
      }

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
