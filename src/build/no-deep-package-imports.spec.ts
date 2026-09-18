import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards against `@warlock.js/<pkg>/src/...` (or any other subpath the
 * package's published `exports` map does not list) reappearing in web's
 * production sources.
 *
 * Why this is a defect and not a style nit: the web PUBLISH build inlines
 * relative files — a bare `../../../core/src/...` import resolves to a real
 * file that ships inside web's own tarball (e.g. 5.11.0 shipped
 * `esm/core/src/router/normalize-route-path.mjs`, reached relatively). A
 * PACKAGE-NAME import, by contrast, stays external: it is resolved through
 * `node_modules` at runtime, against the DEPENDENCY's own published
 * `package.json`. Published `@warlock.js/*` packages expose a narrow
 * `exports` map (typically `.`, `./vite`, `./tests`, `./cli/start`, and a
 * handful of dev-server workers) with no `./src/*` entry, so
 * `@warlock.js/core/src/router/normalize-route-path` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` the moment it runs against a real install.
 * A check run inside this monorepo cannot see that failure, because the
 * monorepo's own `core/package.json` has no `exports` map at all (`main`
 * points straight at `./src/index.ts`), so the deep import silently resolves
 * in-repo and only breaks once published.
 *
 * The fix, every time, is either:
 *   - a genuinely relative import (`../../../core/src/...`), which the
 *     publish build inlines, or
 *   - importing through the package root (`@warlock.js/core`), which the
 *     published `exports` map does support.
 *
 * SCOPE: production sources under `web/src` only — `*.spec.*` files and
 * `__tests__/**` are excluded, since test-only code never ships in the
 * published tarball and can reach into a sibling package's `src` freely.
 */

const SRC_ROOT = path.resolve(__dirname, "..");

const DEEP_PACKAGE_IMPORT = /@warlock\.js\/[^/"'`]+\/src\//;

// Matches the specifier out of `from "..."`, bare `import "..."`, and
// dynamic `import("...")` forms, static or type-only.
const SPECIFIER_PATTERN =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;

function isProductionSourceFile(fileName: string): boolean {
  if (!fileName.endsWith(".ts") && !fileName.endsWith(".tsx")) return false;
  if (fileName.includes(".spec.")) return false;

  return true;
}

function walk(directory: string, hits: { file: string; line: number; specifier: string }[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      walk(fullPath, hits);
      continue;
    }

    if (!entry.isFile() || !isProductionSourceFile(entry.name)) continue;

    const source = fs.readFileSync(fullPath, "utf-8");
    const lines = source.split("\n");

    lines.forEach((lineText, index) => {
      SPECIFIER_PATTERN.lastIndex = 0;
      let match = SPECIFIER_PATTERN.exec(lineText);

      while (match !== null) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? "";

        if (DEEP_PACKAGE_IMPORT.test(specifier)) {
          hits.push({ file: fullPath, line: index + 1, specifier });
        }

        match = SPECIFIER_PATTERN.exec(lineText);
      }
    });
  }
}

describe("no @warlock.js/<pkg>/src deep imports", () => {
  it("forbids importing a sibling package's src/ subpath by package name", () => {
    const hits: { file: string; line: number; specifier: string }[] = [];

    walk(SRC_ROOT, hits);

    if (hits.length > 0) {
      const report = hits
        .map(
          (hit) => `  ${path.relative(SRC_ROOT, hit.file)}:${hit.line} imports "${hit.specifier}"`,
        )
        .join("\n");

      throw new Error(
        "Found package-name import(s) reaching into a sibling package's src/ subpath:\n" +
          report +
          "\n\nPublished @warlock.js/* packages expose a narrow `exports` map with no " +
          "`./src/*` entry, so a package-name import to `.../src/...` resolves only " +
          "inside this monorepo checkout and throws ERR_PACKAGE_PATH_NOT_EXPORTED once " +
          "published. Use a genuinely relative import instead (the publish build " +
          "inlines it), or import through the package root, which the published " +
          "exports map does support.",
      );
    }

    expect(hits).toEqual([]);
  });
});
