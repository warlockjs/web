import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { WEB_ESBUILD_PATCH } from "../build/generate-pages-barrel";
import { gateBSecrets } from "./gate-b-secrets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "gate-b");

/**
 * Runs a real Vite build (JS API, not npx) for a single
 * fixture entry, with Gate B as the only plugin. Verifies the actual
 * emitted build failure/success, never the transform logic in isolation —
 * same discipline as D.1-D.3.
 */
async function buildEntry(fileName: string) {
  return build({
    root: FIXTURE_ROOT,
    // Stated, not inherited (canon a31d170c). This matches Vite's own default
    // for `build()`, so it changes nothing today — it is here so that what the
    // fixtures are compiled under is written down rather than assumed.
    //
    // NOTE: `mode` does NOT decide `import.meta.env.DEV`. That comes from
    // Vite's `isProduction`, which reads NODE_ENV first — and vitest sets
    // NODE_ENV=test when the shell leaves it empty. See case 8.
    mode: "production",
    logLevel: "silent",
    plugins: [gateBSecrets()],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(FIXTURE_ROOT, fileName),
        formats: ["es"],
        fileName: () => "out.js",
      },
    },
  });
}

function firstChunkCode(result: Awaited<ReturnType<typeof buildEntry>>): string {
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = "output" in output ? output.output[0] : undefined;
  if (!chunk || chunk.type !== "chunk") throw new Error("expected a JS chunk in the build output");
  return chunk.code;
}

describe("gateBSecrets — Gate B inline-secret transform gate (real Vite builds)", () => {
  it("case 1: process.env.SECRET_KEY (dot notation) in a component fails, correct message", async () => {
    try {
      await buildEntry("case1-process-env-dot.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain("File: ");
      expect(message).toContain("case1-process-env-dot.tsx:");
      expect(message).toContain("Expression: process.env.SECRET_KEY");
      expect(message).toContain("Cause:");
      expect(message).toContain("process.env.SECRET_KEY");
      expect(message).toContain("Fix:");
    }
  });

  it('case 2: process.env["SECRET_KEY"] (static bracket) in a component fails', async () => {
    try {
      await buildEntry("case2-process-env-bracket.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain('Expression: process.env["SECRET_KEY"]');
      expect(message).toContain("Cause:");
      expect(message).toContain("process.env.SECRET_KEY");
      expect(message).toContain("Fix:");
    }
  });

  it("case 3: import.meta.env.PUBLIC_API_URL passes (build succeeds)", async () => {
    const result = await buildEntry("case3-import-meta-env-public.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("Case3Component");
  });

  it("case 4: import.meta.env.DATABASE_URL (no PUBLIC_ prefix) fails", async () => {
    try {
      await buildEntry("case4-import-meta-env-private.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain("Expression: import.meta.env.DATABASE_URL");
      expect(message).toContain("Cause:");
      expect(message).toContain("PUBLIC_");
      expect(message).toContain("Fix:");
    }
  });

  it("case 5: import.meta.env[someRuntimeVariable] (computed key) fails — never-guess case", async () => {
    try {
      await buildEntry("case5-import-meta-env-computed.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain("Expression: import.meta.env[someRuntimeVariable]");
      expect(message).toContain("Cause:");
      expect(message).toContain("computed key");
      expect(message).toContain("Fix:");
    }
  });

  it("case 6: the secret read is inside a HELPER file imported by a page, not the page itself — still caught", async () => {
    try {
      await buildEntry("case6-helper-page.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain("case6-helper.ts:");
      expect(message).toContain("Expression: process.env.SECRET_KEY");
      expect(message).toContain("Fix:");
    }
  });

  it("case 7: import.meta.env.MODE (Vite built-in) passes despite no PUBLIC_ prefix, and is inlined for real", async () => {
    const result = await buildEntry("case7-import-meta-env-mode.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("Case7Component");
    expect(code).toContain('"production"');
  });

  /**
   * What this case is actually about is the GATE: `DEV` carries no `PUBLIC_`
   * prefix, and Gate B must still let it through because it is a Vite built-in
   * — and Vite must still inline it, so nothing reaches the browser as a
   * runtime lookup.
   *
   * It used to assert the literal `false`. That is not a property of the gate;
   * it is a property of whoever ran the suite. Vite's `isProduction` reads
   * NODE_ENV before it reads `mode`, and vitest sets NODE_ENV=test when the
   * shell leaves it unset — so the assertion passed under this machine's
   * agent shells (which export NODE_ENV=production) and failed in a clean one.
   * Green for a reason that had nothing to do with the code under test.
   *
   * So assert the inlining itself: a boolean literal is present and no
   * `import.meta.env` survives into the chunk. True in either environment,
   * and it fails if the gate ever stops inlining.
   */
  it("case 8: import.meta.env.DEV (Vite built-in) passes despite no PUBLIC_ prefix, and is inlined for real", async () => {
    const result = await buildEntry("case8-import-meta-env-dev.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("Case8Component");
    expect(code).toMatch(/return (true|false);/);
    expect(code).not.toContain("import.meta.env");
  });

  it("case 9: only one of two declared PUBLIC_* vars is read anywhere in the client build — the read one is inlined, the unread one is not, verified on the emitted bundle", async () => {
    const previousReadVar = process.env.PUBLIC_READ_VAR;
    const previousUnreadVar = process.env.PUBLIC_UNREAD_VAR;
    process.env.PUBLIC_READ_VAR = "read-var-value-marker";
    process.env.PUBLIC_UNREAD_VAR = "unread-var-value-marker";
    try {
      const result = await buildEntry("case9-entry.tsx");
      const code = firstChunkCode(result);
      expect(code).toContain("read-var-value-marker");
      expect(code).not.toContain("unread-var-value-marker");
    } finally {
      process.env.PUBLIC_READ_VAR = previousReadVar;
      process.env.PUBLIC_UNREAD_VAR = previousUnreadVar;
    }
  });

  describe("a bare `import.meta.env` value-reference fails at transform time, not only as a whole-build failure", () => {
    it("case 10: const env = import.meta.env (aliased) fails at transform time, source-line-pointing", async () => {
      try {
        await buildEntry("case10-import-meta-env-aliased.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        // Same file/line/expression/cause/fix shape as every other Gate B
        // violation (case 1-8 above) — NOT the whole-build generateBundle
        // message ("Gate B refused a build: an unread PUBLIC_ env var...").
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case10-import-meta-env-aliased.tsx:");
        expect(message).toContain("Expression: import.meta.env");
        expect(message).toContain("Cause:");
        expect(message).toContain("whole object");
        expect(message).toContain("Fix:");
      }
    });

    it('case 11: fn({...import.meta.env}) (spread) fails at transform time, source-line-pointing', async () => {
      try {
        await buildEntry("case11-import-meta-env-spread.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case11-import-meta-env-spread.tsx:");
        expect(message).toContain("Expression: import.meta.env");
        expect(message).toContain("Cause:");
        expect(message).toContain("whole object");
        expect(message).toContain("Fix:");
      }
    });
  });

  describe("process.env reached through an indirect global object", () => {
    it("case 12: globalThis.process.env.SECRET_KEY fails", async () => {
      try {
        await buildEntry("case12-global-this-process-env.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: globalThis.process.env.SECRET_KEY");
      }
    });

    it("case 13: window.process.env.SECRET_KEY fails", async () => {
      try {
        await buildEntry("case13-window-process-env.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: window.process.env.SECRET_KEY");
      }
    });

    it("case 14: self.process.env.SECRET_KEY fails", async () => {
      try {
        await buildEntry("case14-self-process-env.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: self.process.env.SECRET_KEY");
      }
    });

    it('case 15: globalThis["process"].env.SECRET_KEY fails', async () => {
      try {
        await buildEntry("case15-global-this-process-bracket.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain('Expression: globalThis["process"].env.SECRET_KEY');
      }
    });

    it("case 16: globalThis?.process?.env?.SECRET_KEY fails", async () => {
      try {
        await buildEntry("case16-global-this-process-optional.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: globalThis?.process?.env?.SECRET_KEY");
      }
    });

    it("case 17: window?.process?.env?.SECRET_KEY fails", async () => {
      try {
        await buildEntry("case17-window-process-optional.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: window?.process?.env?.SECRET_KEY");
      }
    });

    it("case 18: self?.process?.env?.SECRET_KEY fails", async () => {
      try {
        await buildEntry("case18-self-process-optional.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: self?.process?.env?.SECRET_KEY");
      }
    });

    it('case 19: globalThis?.["process"]?.env?.SECRET_KEY fails', async () => {
      try {
        await buildEntry("case19-global-this-process-bracket-optional.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain('Expression: globalThis?.["process"]?.env?.SECRET_KEY');
      }
    });

    it("case 20: a process-object alias remains outside the structural matcher and passes", async () => {
      const result = await buildEntry("case20-process-object-alias.tsx");
      const code = firstChunkCode(result);
      expect(code).toContain("Case20Component");
    });
  });

  describe("a bare `process.env` value-reference fails at transform time, mirroring the import.meta.env check", () => {
    it("case 21: const env = process.env (aliased) fails at transform time, source-line-pointing", async () => {
      try {
        await buildEntry("case21-process-env-aliased.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case21-process-env-aliased.tsx:");
        expect(message).toContain("Expression: process.env");
        expect(message).toContain("Cause:");
        expect(message).toContain("whole object");
        expect(message).toContain("Fix:");
      }
    });

    it("case 22: fn({...process.env}) (spread) fails at transform time, source-line-pointing", async () => {
      try {
        await buildEntry("case22-process-env-spread.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case22-process-env-spread.tsx:");
        expect(message).toContain("Expression: process.env");
        expect(message).toContain("Cause:");
        expect(message).toContain("whole object");
        expect(message).toContain("Fix:");
      }
    });

    it("case 23: const { APP_SECRET } = process.env (destructured) fails at transform time", async () => {
      try {
        await buildEntry("case23-process-env-destructure.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case23-process-env-destructure.tsx:");
        expect(message).toContain("Expression: process.env");
        expect(message).toContain("whole object");
      }
    });

    it("case 24: Object.keys(process.env) fails at transform time", async () => {
      try {
        await buildEntry("case24-process-env-object-keys.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case24-process-env-object-keys.tsx:");
        expect(message).toContain("Expression: process.env");
        expect(message).toContain("whole object");
      }
    });

    it("case 25: JSON.stringify(process.env) fails at transform time", async () => {
      try {
        await buildEntry("case25-process-env-json-stringify.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module: forbidden inline env read in the client build.");
        expect(message).toContain("case25-process-env-json-stringify.tsx:");
        expect(message).toContain("Expression: process.env");
        expect(message).toContain("whole object");
      }
    });

    it("case 26: process.env[someRuntimeVariable] (computed key) fails — never-guess case", async () => {
      try {
        await buildEntry("case26-process-env-computed-bracket.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: process.env[someRuntimeVariable]");
        expect(message).toContain("Cause:");
        expect(message).toContain("computed key");
        expect(message).toContain("Fix:");
      }
    });

    /**
     * Documents ACTUAL behavior, not a request-spec claim: `process.env.X` is
     * refused for EVERY key, "PUBLIC_"-prefixed or not — see this file's own
     * header comment ("process.env is never readable client-side at all ...
     * forbidden regardless of X") and the narrowed-read branch's cause
     * message ("there is no 'public' process.env key, static or computed").
     * That branch is pre-existing and intentionally untouched here. Unlike
     * `import.meta.env`, `process.env` has no PUBLIC_-prefixed allowed path
     * at all, narrowed or bare.
     */
    it("case 27: process.env.PUBLIC_API_URL (literal PUBLIC_ key) still fails — process.env has no allowed key, unlike import.meta.env", async () => {
      try {
        await buildEntry("case27-process-env-public-literal.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate B refused a module");
        expect(message).toContain("Expression: process.env.PUBLIC_API_URL");
      }
    });
  });
});

/**
 * Not Gate B — this is `WEB_ESBUILD_PATCH.define` (build/generate-pages-barrel.ts),
 * esbuild's own `transform()`, no Vite involved. It lives here because the claim
 * under test is the load-bearing one behind `shared.ts`'s `import.meta.env?.DEV`
 * comment (shared.ts:373-378), and this is the nearest executable-esbuild-behavior
 * spec in the tree.
 */
describe("WEB_ESBUILD_PATCH.define — real esbuild transform, not Vite", () => {
  it("replaces `import.meta.env?.DEV` (optional chaining) with the defined literal, whole expression gone", () => {
    const { code } = transformSync("if (import.meta.env?.DEV) { doSomething(); }", {
      define: WEB_ESBUILD_PATCH.define as Record<string, string>,
      loader: "ts",
    });

    expect(code).not.toContain("import.meta");
    expect(code).toContain("if (false)");
  });

  it("replaces plain `import.meta.env.DEV` (no optional chaining) the same way", () => {
    const { code } = transformSync("if (import.meta.env.DEV) { doSomething(); }", {
      define: WEB_ESBUILD_PATCH.define as Record<string, string>,
      loader: "ts",
    });

    expect(code).not.toContain("import.meta");
    expect(code).toContain("if (false)");
  });
});
