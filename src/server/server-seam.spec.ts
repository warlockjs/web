import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWebServerBarrelPath } from "./web-connector";

// Resolves the same way `WebConnector.resolvePaths()` does: from
// `web-connector.ts`'s own location, not this spec's — a spec-relative path
// would pass even if the connector's resolution broke.
const webConnectorPath = fileURLToPath(new URL("./web-connector.ts", import.meta.url));

const srcDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * `src/server/index.ts` is loaded ONLY via `vite.ssrLoadModule` by
 * `web-connector.ts` (see this file's other block, and the module header on
 * `./index.ts`). It is deliberately not a `package.json` export and not
 * re-exported from any client-bound entry — a package export or a barrel
 * re-export would let app code reach the pipeline's wiring surface directly.
 *
 * Reuses `main-entry-client-boundary.spec.ts`'s esbuild-graph approach: build
 * each client-bound entry with every bare specifier external, then assert
 * `server/index.ts` never appears in the resulting input graph. This is a
 * check of the SOURCE GRAPH, independent of any consuming app's bundler
 * config.
 */
describe("server-seam client-entry isolation", () => {
  const clientEntries = [
    ["root barrel", path.join(srcDir, "index.ts")],
    ["client runtime", path.join(srcDir, "client/runtime/index.ts")],
    ["sitemap subpath", path.join(srcDir, "sitemap/index.ts")],
    ["build subpath", path.join(srcDir, "build/index.ts")],
    ["page-cache subpath", path.join(srcDir, "page-cache.ts")],
  ] as const;

  /**
   * Explicit timeout, and the number is measured rather than guessed.
   *
   * Each case runs a REAL esbuild bundle of a real entry point, so the default
   * 5s is not a budget this work can fit in — and when it overran, the case
   * did not fail, it ABSTAINED. A boundary guard that times out has neither
   * passed nor failed, so nothing here could be relied on either way.
   *
   * What the time actually goes on: with the timeout raised, this file's seven
   * cases spend 8.43s in tests and 256s in import/transform. The assertions are
   * cheap; loading the module graph in a cold worker is not, and vitest's
   * per-test clock runs through it. 30s leaves room for that on a loaded
   * machine without being so large that a genuine hang looks like slowness.
   */
  const BUNDLE_TIMEOUT_MS = 30_000;

  it.each(clientEntries)(
    "%s never reaches src/server/index.ts",
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

      const serverIndexInputs = Object.keys(result.metafile.inputs)
        .map((inputPath) => path.resolve(inputPath).split(path.sep).join("/"))
        .filter((inputPath) => inputPath.endsWith("src/server/index.ts"));

      expect(serverIndexInputs).toEqual([]);
    },
    BUNDLE_TIMEOUT_MS,
  );
});

describe("server-seam", () => {
  it("resolves to a file that exists on disk", () => {
    const barrelPath = resolveWebServerBarrelPath(webConnectorPath);

    expect(fs.existsSync(barrelPath)).toBe(true);
  });

  it("exports every member web-connector reads off the ssrLoadModule result", async () => {
    const barrelPath = resolveWebServerBarrelPath(webConnectorPath);
    const barrel = await import(barrelPath);

    // `web-connector.ts` reads exactly these three off `webServerSsr`
    // (`connectSharedStore`/`connectPageContext` at boot, `installPageRoutes`
    // from the returned `installDevPageRoutes` closure). Losing any one of
    // them here is the same failure as losing it in the real dev server.
    expect(typeof barrel.connectSharedStore).toBe("function");
    expect(typeof barrel.connectPageContext).toBe("function");
    expect(typeof barrel.installPageRoutes).toBe("function");
  });
});
