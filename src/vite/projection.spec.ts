import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { projection } from "./projection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "projection");

/**
 * A minimal stand-in for Rollup's plugin `this` context: only `error`,
 * which is the one method `projection()`'s `transform` hook calls, and
 * which — like the real Rollup one — throws.
 */
const pluginContext = {
  error(message: string): never {
    throw new Error(message);
  },
};

type TransformHook = (
  this: typeof pluginContext,
  code: string,
  id: string,
  options?: { ssr?: boolean },
) => Promise<{ code: string; map: unknown } | string | null>;

/**
 * Invokes the REAL `transform` hook Vite would call — not a reimplementation
 * of the AST logic — and hands back whatever it returns, so every assertion
 * below reads the actual transformed output source (`kepler-D2-projection-brief.md`:
 * "verify on the actual transformed OUTPUT source ... never by asserting the
 * AST manipulation logic in isolation").
 */
async function runTransform(fileName: string, options?: { ssr?: boolean }) {
  const id = path.join(FIXTURE_DIR, fileName);
  const code = readFileSync(id, "utf-8");
  const plugin: Plugin = projection();
  const hook = plugin.transform as unknown as TransformHook;
  const result = await hook.call(pluginContext, code, id, options);
  return { id, result };
}

async function transformedCode(fileName: string): Promise<string> {
  const { result } = await runTransform(fileName);
  if (result === null) throw new Error(`expected ${fileName} to be transformed, got null`);
  return typeof result === "string" ? result : result.code;
}

describe("projection — strip the 5 server exports (real transform hook, real output)", () => {
  it("case 1: a shared import between loader and the component survives; all 5 server exports are gone", async () => {
    const code = await transformedCode("case1-shared-import.page.tsx");

    expect(code).toContain('from "./helper"');
    expect(code).not.toMatch(/export const route/);
    expect(code).not.toMatch(/export const middleware/);
    expect(code).not.toMatch(/export const validation/);
    expect(code).not.toMatch(/export const loader/);
    expect(code).not.toMatch(/export const metadata/);
    expect(code).toContain("export default function BlogPage");
    expect(code).toContain("formatTitle(data.title)");
  });

  it("case 2: an import used only inside loader is transitively removed", async () => {
    const code = await transformedCode("case2-orphaned-import.page.tsx");

    expect(code).not.toContain("server-only-helper");
    expect(code).not.toMatch(/export const loader/);
    expect(code).not.toContain("fetchDraftStats");
    expect(code).toContain("export default function BlogPage");
  });

  it("case 3: a bare CSS import survives projection untouched", async () => {
    const code = await transformedCode("case3-css-import.page.tsx");

    expect(code).toContain('import "./styles.css"');
    expect(code).not.toMatch(/export const route/);
    expect(code).not.toMatch(/export const loader/);
  });

  it("case 4: a top-level statement outside any export fails the build, naming file/statement/fix", async () => {
    const id = path.join(FIXTURE_DIR, "case4-ambiguous-statement.page.tsx");

    try {
      await runTransform("case4-ambiguous-statement.page.tsx");
      expect.unreachable("expected the transform to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(id);
      expect(message).toContain('console.log("boot")');
      expect(message).toContain("Cause:");
      expect(message).toContain("Fix:");
    }
  });

  it("case 5: `export async function loader(...)` (function-declaration form) is stripped correctly", async () => {
    const code = await transformedCode("case5-function-loader.page.tsx");

    expect(code).not.toMatch(/export async function loader/);
    expect(code).not.toMatch(/async function loader\(/);
    expect(code).toContain("export default function BlogPage");
  });

  it("skips the SSR build entirely — the server still needs all 5 exports intact", async () => {
    const { result } = await runTransform("case1-shared-import.page.tsx", { ssr: true });
    expect(result).toBeNull();
  });

  it("ignores files that are not *.page.tsx/layout.tsx/App.tsx", async () => {
    const { result } = await runTransform("helper.ts");
    expect(result).toBeNull();
  });
});
