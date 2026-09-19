import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `<Image>` renders descriptors and NEVER runs Sharp, inspects a file or
 * imports server-only code (canon `08e7acb0`) — this is a check of the
 * SOURCE GRAPH, the same esbuild-graph approach `server-seam.spec.ts` and
 * `main-entry-client-boundary.spec.ts` use, extended with `sharp` and
 * `@warlock.js/core` as forbidden destinations.
 *
 * Scoped to `src/image/**` only, not the root barrel: the root barrel
 * already legitimately reaches `src/server/public-page-error.ts` (for
 * `PublicPageError`) and `src/server/page-render-bundle.ts` for reasons that
 * predate and are unrelated to `<Image>` — `server-seam.spec.ts` already
 * guards the barrel against the one path that matters there,
 * `src/server/index.ts`. Re-asserting a stricter rule against the whole
 * barrel here would fail on that pre-existing, correct import.
 */
describe("image module boundary", () => {
  const imageDir = fileURLToPath(new URL(".", import.meta.url));
  const srcDir = path.resolve(imageDir, "..");

  const entries = [["image module barrel", path.join(imageDir, "image.tsx")]] as const;

  it.each(entries)(
    "%s never reaches src/server/**, sharp, or @warlock.js/core",
    async (_label, entry) => {
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        metafile: true,
        platform: "browser",
        format: "esm",
        logLevel: "silent",
        packages: "external",
        outfile: path.join(srcDir, "__out__.js"), // virtual — write: false means nothing lands on disk
      });

      const inputPaths = Object.keys(result.metafile.inputs).map((inputPath) =>
        path.resolve(inputPath).split(path.sep).join("/"),
      );

      const serverInputs = inputPaths.filter((inputPath) => inputPath.includes("/src/server/"));
      expect(serverInputs).toEqual([]);

      const externalSpecifiers = Object.values(result.metafile.outputs).flatMap((output) =>
        (output.imports ?? []).map((entry) => entry.path),
      );
      expect(externalSpecifiers.some((specifier) => specifier.includes("sharp"))).toBe(false);
      expect(externalSpecifiers.some((specifier) => specifier.includes("@warlock.js/core"))).toBe(
        false,
      );
    },
    20_000,
  );
});
