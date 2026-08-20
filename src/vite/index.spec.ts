import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { warlockClientBoundary } from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "composed");
const PAGE_DIR = path.join(FIXTURE_ROOT, "app", "blog", "web");

const GATE_A_FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "gate-a");
const GATE_A_PAGE_DIR = path.join(GATE_A_FIXTURE_ROOT, "app", "blog", "web");

/**
 * Runs a real Vite build (JS API — canon `50608334`) through the COMPOSED
 * pipeline (`projection` + Gate A `resolveId`, in that order), for a single
 * fixture page — never the two plugins in isolation. Verifies the actual
 * emitted outcome, matching D.1/D.2's verification convention.
 */
async function buildPage(fileName: string) {
  return build({
    root: FIXTURE_ROOT,
    logLevel: "silent",
    plugins: [warlockClientBoundary({ appRoot: FIXTURE_ROOT })],
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

describe("warlockClientBoundary — composed projection + Gate A pipeline (real Vite builds)", () => {
  it("case 1 (positive): loader-only @warlock.js/core import is stripped by projection before Gate A sees it, build succeeds", async () => {
    const result = await buildPage("case1-loader-only-core-import.page.tsx");
    const code = firstChunkCode(result);

    expect(code).not.toContain("@warlock.js/core");
    expect(code).not.toContain("loader");
    expect(code).toContain("blog page");
  });

  it("case 2 (negative control): a component-level @warlock.js/core import is never touched by projection and is still refused by Gate A", async () => {
    try {
      await buildPage("case2-component-core-import.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case2-component-core-import.page.tsx → @warlock.js/core",
      );
      expect(message).toContain("Cause:");
      expect(message).toContain("server-only @warlock.js package");
      expect(message).toContain("Fix:");
    }
  });

  it("case 3 (Gate B): an inline process.env read inside the page component survives projection and is refused by Gate B", async () => {
    try {
      await buildPage("case3-inline-secret.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain("case3-inline-secret.page.tsx:");
      expect(message).toContain("Expression: process.env.SECRET_KEY");
      expect(message).toContain("Cause:");
      expect(message).toContain("Fix:");
    }
  });
});

describe("D.3 hook ordering pin (Suki, room seq 546 pt.3) — transform runs before resolveId", () => {
  it("records transform(entry) firing before resolveId of the entry's own surviving import specifier, via a real vite.build()", async () => {
    // Instrumented real build (not asserted from plugin array order — see
    // the ordering-dependent comment above `warlockClientBoundary` in
    // `index.ts`). Pins the exact fact D.3 discovered: for a given module,
    // Rollup must parse its post-transform source before it can even
    // discover which import specifiers to resolve next, so `transform`
    // necessarily fires before `resolveId` for that module's own imports.
    // If a future Vite/Rollup upgrade inverts this, this test fails loudly
    // — see the comment above `warlockClientBoundary` for why that failure
    // mode is safe and must not be "fixed" by weakening Gate A instead.
    const entryFile = "case3-universal-pass.page.tsx";
    const events: string[] = [];
    const recorder: Plugin = {
      name: "test:hook-order-recorder",
      // `enforce: "pre"` for the same reason Gate A itself needs it (see
      // `gate-a-resolve.ts`): Vite's own core resolver would otherwise
      // resolve "./helper" before this plugin's `resolveId` runs at all.
      enforce: "pre",
      transform(_code, id) {
        if (id.endsWith(entryFile)) events.push(`transform:${path.basename(id)}`);
        return null;
      },
      resolveId(source, importer) {
        if (source === "./helper" && importer?.endsWith(entryFile)) {
          events.push(`resolveId:${source}`);
        }
        return null;
      },
    };

    await build({
      root: GATE_A_FIXTURE_ROOT,
      logLevel: "silent",
      plugins: [recorder],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(GATE_A_PAGE_DIR, entryFile),
          formats: ["es"],
          fileName: () => "out.js",
        },
      },
    });

    const transformIndex = events.indexOf(`transform:${entryFile}`);
    const resolveIdIndex = events.indexOf("resolveId:./helper");

    expect(transformIndex).toBeGreaterThanOrEqual(0);
    expect(resolveIdIndex).toBeGreaterThanOrEqual(0);
    expect(transformIndex).toBeLessThan(resolveIdIndex);
  });
});
