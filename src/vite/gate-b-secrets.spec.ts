import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
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

  it("case 8: import.meta.env.DEV (Vite built-in) passes despite no PUBLIC_ prefix, and is inlined for real", async () => {
    const result = await buildEntry("case8-import-meta-env-dev.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("Case8Component");
    expect(code).toContain("false");
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
});
