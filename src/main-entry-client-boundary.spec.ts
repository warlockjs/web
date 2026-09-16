import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard for the Gate A blocker this file's header comment
 * documents in `../index.ts` (`invalidatePageCache` moved to the
 * server-only subpath `@warlock.js/web/server`): the MAIN entry's import
 * graph must never be able to reach `@warlock.js/cache` (a server-only
 * `@warlock.js/*` package — `warlock: { environment: "server" }`), because
 * this entry is imported by client code (e.g. `root.tsx`).
 *
 * Uses esbuild directly rather than Gate A's Vite plugin: this is a
 * standalone check of the SOURCE GRAPH, independent of whether a consuming
 * app's Vite config even wires Gate A up correctly. Every bare package
 * specifier is marked external so the bundle only needs to resolve THIS
 * package's own local files — no node_modules build is required to answer
 * "does the graph reach page-cache-driver.ts".
 */
describe("main entry (index.ts) client-boundary regression", () => {
  it("never bundles page-cache-driver.ts, and never imports @warlock.js/cache", async () => {
    const entry = path.join(__dirname, "index.ts");

    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
      packages: "external", // every bare specifier ("react", "@warlock.js/*", ...) stays external
      outfile: path.join(__dirname, "__out__.js"), // virtual — write: false means nothing lands on disk
    });

    const inputPaths = Object.keys(result.metafile.inputs).map((p) => path.resolve(p));
    const pageCacheDriverInputs = inputPaths.filter((p) =>
      p.replace(/\\/g, "/").endsWith("src/server/page-cache-driver.ts"),
    );
    expect(pageCacheDriverInputs).toEqual([]);

    const externalImports = new Set<string>();
    for (const input of Object.values(result.metafile.inputs)) {
      for (const imp of input.imports) {
        if (imp.external) externalImports.add(imp.path);
      }
    }
    expect(externalImports.has("@warlock.js/cache")).toBe(false);
  });
});
