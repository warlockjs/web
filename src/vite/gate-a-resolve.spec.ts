import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { gateAResolve } from "./gate-a-resolve";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "gate-a");
const PAGE_DIR = path.join(FIXTURE_ROOT, "app", "blog", "web");
const SEAL_SRC_DIR = path.join(__dirname, "..", "..", "..", "seal", "src");
const SEAL_SRC = path.join(SEAL_SRC_DIR, "index.ts");

/**
 * Runs a real Vite build (JS API, not npx — canon `50608334`) for a single
 * fixture page, with Gate A as the only plugin. Verifies the actual emitted
 * resolution outcome, never the plugin logic in isolation.
 */
async function buildPage(fileName: string) {
  return build({
    root: FIXTURE_ROOT,
    logLevel: "silent",
    resolve: {
      alias: [
        { find: /^@warlock\.js\/seal$/, replacement: SEAL_SRC },
        { find: /^@warlock\.js\/seal\//, replacement: `${SEAL_SRC_DIR}/` },
      ],
    },
    plugins: [gateAResolve({ appRoot: FIXTURE_ROOT })],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(PAGE_DIR, fileName),
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: {
        // Node builtins are refused by Gate A itself; nothing else should
        // externalize them out from under the gate.
        external: [],
      },
    },
  });
}

function firstChunkCode(result: Awaited<ReturnType<typeof buildPage>>): string {
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = "output" in output ? output.output[0] : undefined;
  if (!chunk || chunk.type !== "chunk") throw new Error("expected a JS chunk in the build output");
  return chunk.code;
}

describe("gateAResolve — Gate A resolveId refusal (real Vite builds)", () => {
  it("case 1: a page importing a @warlock.js/core service directly fails, chain printed", async () => {
    await expect(buildPage("case1-core-import.page.tsx")).rejects.toThrow();

    try {
      await buildPage("case1-core-import.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: case1-core-import.page.tsx → @warlock.js/core");
      expect(message).toContain("Cause:");
      expect(message).toContain("@warlock.js/core");
      expect(message).toContain("server-only @warlock.js package");
      expect(message).toContain("Fix:");
      expect(message).toContain("File:");
    }
  });

  it("case 2: a page importing a sibling .server.ts file directly fails", async () => {
    try {
      await buildPage("case2-server-sibling.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: case2-server-sibling.page.tsx → ./case2.server");
      expect(message).toContain("Cause:");
      expect(message).toContain("server-only file");
      expect(message).toContain("Fix:");
    }
  });

  it("case 3: a page importing a sibling universal helper passes", async () => {
    const result = await buildPage("case3-universal-pass.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("formatTitle");
  });

  it("case 4: a page importing @warlock.js/seal for a schema passes (seal is universal)", async () => {
    const result = await buildPage("case4-seal-import.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("anySchema");
  });

  it("case 5: a page importing node:fs transitively (2-hop) fails, chain shows both hops", async () => {
    try {
      await buildPage("case5-fs-chain.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case5-fs-chain.page.tsx → fs-helper.ts → node:fs",
      );
      expect(message).toContain("Cause:");
      expect(message).toContain("Node.js builtin module");
      expect(message).toContain("Fix:");
    }
  });
});
