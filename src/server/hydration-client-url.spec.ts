import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HYDRATION_CLIENT_ENTRY_NAME } from "../vite/hydration-entries";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";
import {
  resolveHydrationClientUrl,
  WebClientAssetPrefixViolationError,
  WebClientManifestEntryMissingError,
  WebClientManifestMalformedError,
  WebClientManifestMissingError,
} from "./hydration-client-url";

const temporaryDirectories: string[] = [];

function makeClientDir(manifestContents?: string): string {
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-client-"));
  temporaryDirectories.push(clientDir);

  if (manifestContents !== undefined) {
    fs.mkdirSync(path.join(clientDir, ".vite"), { recursive: true });
    fs.writeFileSync(path.join(clientDir, ".vite", "manifest.json"), manifestContents, "utf-8");
  }

  return clientDir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveHydrationClientUrl", () => {
  it("returns '/' + entry.file for the hydration entry the client build wrote", () => {
    const clientDir = makeClientDir(
      JSON.stringify({
        "src/client/index.ts": {
          name: HYDRATION_CLIENT_ENTRY_NAME,
          file: "assets/hydration-abc123.js",
          isEntry: true,
        },
      }),
    );

    expect(resolveHydrationClientUrl({ clientDir })).toBe("/assets/hydration-abc123.js");
  });

  /**
   * THE REGRESSION THIS FILE FAILED TO CATCH ONCE.
   *
   * The resolver used to index the manifest by `manifest[HYDRATION_CLIENT_ENTRY_NAME]`,
   * and the fixtures above used to be written with the entry name as the KEY —
   * so code and test agreed with each other and disagreed with Vite, which
   * keys by source path and records the name in a `name` field. Every real
   * production boot died with `WebClientManifestEntryMissingError` reporting a
   * drift that had not happened.
   *
   * Two entries alongside the real one, both plausible near-misses: a shared
   * chunk carrying the same `name` but no `isEntry`, and a second entry with a
   * different name. Neither may be selected.
   */
  it("finds the entry by its `name` field in a real Vite manifest, never by key", () => {
    const clientDir = makeClientDir(
      JSON.stringify({
        "_hydration-shared.js": {
          name: HYDRATION_CLIENT_ENTRY_NAME,
          file: "assets/hydration-shared-000.js",
        },
        "src/pages/home.page.tsx": {
          name: "home.page",
          file: "assets/home.page-zzz999.js",
          isEntry: true,
        },
        "src/client/index.ts": {
          name: HYDRATION_CLIENT_ENTRY_NAME,
          file: "assets/hydration-real42.js",
          isEntry: true,
        },
      }),
    );

    expect(resolveHydrationClientUrl({ clientDir })).toBe("/assets/hydration-real42.js");
  });

  it("raises WebClientManifestMissingError naming the exact path when the file is absent", () => {
    const clientDir = makeClientDir();

    try {
      resolveHydrationClientUrl({ clientDir });
      expect.unreachable("expected a missing-manifest failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WebClientManifestMissingError);
      expect((error as Error).message).toContain(path.join(clientDir, ".vite", "manifest.json"));
    }
  });

  it("raises WebClientManifestMalformedError on unparsable JSON, wrapping the cause", () => {
    const clientDir = makeClientDir("{ not json");

    try {
      resolveHydrationClientUrl({ clientDir });
      expect.unreachable("expected a malformed-manifest failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WebClientManifestMalformedError);
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("raises WebClientManifestMalformedError when the manifest root is not an object", () => {
    const clientDir = makeClientDir("[]");

    expect(() => resolveHydrationClientUrl({ clientDir })).toThrowError(
      WebClientManifestMalformedError,
    );
  });

  it("raises WebClientManifestEntryMissingError naming key and path on entry drift", () => {
    const clientDir = makeClientDir(JSON.stringify({ "some-other-entry": { file: "a.js" } }));

    try {
      resolveHydrationClientUrl({ clientDir });
      expect.unreachable("expected an entry-missing failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WebClientManifestEntryMissingError);
      expect((error as Error).message).toContain(HYDRATION_CLIENT_ENTRY_NAME);
      expect((error as Error).message).toContain(path.join(clientDir, ".vite", "manifest.json"));
    }
  });

  it("never falls back when the entry exists without a file string", () => {
    const clientDir = makeClientDir(JSON.stringify({ [HYDRATION_CLIENT_ENTRY_NAME]: {} }));

    expect(() => resolveHydrationClientUrl({ clientDir })).toThrowError(
      WebClientManifestEntryMissingError,
    );
  });

  it("raises WebClientAssetPrefixViolationError when the entry file sits outside the assets dir", () => {
    const clientDir = makeClientDir(
      JSON.stringify({
        "src/client/index.ts": {
          name: HYDRATION_CLIENT_ENTRY_NAME,
          file: "entry-abc.js",
          isEntry: true,
        },
      }),
    );

    let resolved: string | undefined;
    let thrown: unknown;

    try {
      resolved = resolveHydrationClientUrl({ clientDir });
    } catch (error) {
      thrown = error;
    }

    expect(resolved, "a non-assets entry must not resolve to a URL").toBeUndefined();
    expect(thrown).toBeInstanceOf(WebClientAssetPrefixViolationError);
    expect((thrown as Error).message).toContain("entry-abc.js");
  });

  it("returns a URL under the one shared client-asset prefix, by construction", () => {
    const clientDir = makeClientDir(
      JSON.stringify({
        "src/client/index.ts": {
          name: HYDRATION_CLIENT_ENTRY_NAME,
          file: "assets/hydration-abc123.js",
          isEntry: true,
        },
      }),
    );

    expect(resolveHydrationClientUrl({ clientDir }).startsWith(CLIENT_ASSET_URL_PREFIX)).toBe(true);
  });
});
