import { parse } from "@babel/parser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import type { Plugin } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { CLIENT_REGISTRY_EXPORT_NAME } from "../build/generate-client-registry";
import { warlockClientBoundary } from "./index";
import {
  CLIENT_PAGE_REGISTRY_ID,
  clientPageRegistry,
  RESOLVED_CLIENT_PAGE_REGISTRY_ID,
} from "./page-registry-plugin";

/**
 * Fixture trees are built in a temp dir rather than checked in under
 * `__tests__/vite/fixtures/`: the ordering proof needs a page whose `loader`
 * imports a marker module, and writing it here keeps the marker string and the
 * assertion that hunts for it in one file, where they cannot drift.
 */
const tempRoots: string[] = [];

function makeAppRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-page-registry-"));
  tempRoots.push(root);
  return root;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf-8");
}

afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** A minimal page: one `route` export discovery can read statically, one default component. */
function pageSource(routePath: string, body: string): string {
  return [
    `export const route = { path: ${JSON.stringify(routePath)} };`,
    ``,
    ...body.split("\n"),
  ].join("\n");
}

/** Invokes a plugin hook the way Rollup does — as a plain function, with a stubbed plugin context. */
function callHook<T>(plugin: Plugin, hook: "resolveId" | "load", ...args: any[]): T {
  const handler = plugin[hook];
  const fn = typeof handler === "function" ? handler : (handler as any)?.handler;
  return fn.apply({ error: (message: string) => { throw new Error(message); } }, args) as T;
}

describe("clientPageRegistry — virtual module id contract", () => {
  it("resolveId returns the \\0 id for the public id and undefined for anything else", () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });

    expect(callHook(plugin, "resolveId", CLIENT_PAGE_REGISTRY_ID)).toBe(
      RESOLVED_CLIENT_PAGE_REGISTRY_ID,
    );
    expect(RESOLVED_CLIENT_PAGE_REGISTRY_ID.startsWith("\0")).toBe(true);
    expect(callHook(plugin, "resolveId", "./some-real-file.tsx")).toBeUndefined();
    expect(callHook(plugin, "resolveId", "react")).toBeUndefined();
    // The un-prefixed public id must NOT be treated as already-resolved.
    expect(callHook(plugin, "resolveId", RESOLVED_CLIENT_PAGE_REGISTRY_ID)).toBeUndefined();
  });

  it("load returns undefined for an unrelated id", () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });

    expect(callHook(plugin, "load", "/some/real/file.tsx")).toBeUndefined();
    // The PUBLIC id is not the loadable one — only the \0 id is.
    expect(callHook(plugin, "load", CLIENT_PAGE_REGISTRY_ID)).toBeUndefined();
  });

  it("load on the \\0 id emits the registry export and one import() per discovered page, in discovery order", () => {
    const appRoot = makeAppRoot();
    writeFile(
      path.join(appRoot, "src/app/blog/web/article.page.tsx"),
      pageSource("/blog/article", "export default function Article() {\n  return null;\n}\n"),
    );
    writeFile(
      path.join(appRoot, "src/app/shop/web/item.page.tsx"),
      pageSource("/shop/item", "export default function Item() {\n  return null;\n}\n"),
    );

    const source = callHook<string>(
      clientPageRegistry({ appRoot }),
      "load",
      RESOLVED_CLIENT_PAGE_REGISTRY_ID,
    );

    expect(source).toContain(`export const ${CLIENT_REGISTRY_EXPORT_NAME}`);

    // `import("` — the emitted CALLS. A bare `import(` also matches the
    // generator's own header comment, which explains the dynamic-import
    // policy in prose.
    const importCount = source.match(/import\("/g)?.length ?? 0;
    expect(importCount).toBe(2);

    // Two pages, two entries, in discovery order (POSIX source-path sort).
    const paths = [...source.matchAll(/path: "([^"]+)"/g)].map((match) => match[1]);
    expect(paths).toEqual(["/blog/article", "/shop/item"]);

    // Absolute POSIX specifiers — never relative, because the importer is a
    // \0 id whose dirname is not a real directory.
    const specifiers = [...source.matchAll(/import\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(specifiers).toHaveLength(2);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^\./);
      expect(specifier).not.toContain("\\");
      expect(path.isAbsolute(specifier)).toBe(true);
    }
  });

  it("emits plain JavaScript — a \\0 id is never reached by vite:esbuild, so TypeScript here is a Rollup parse error", () => {
    const appRoot = makeAppRoot();
    writeFile(
      path.join(appRoot, "src/web/home.page.tsx"),
      pageSource("/", "export default function Home() {\n  return null;\n}\n"),
    );

    const source = callHook<string>(
      clientPageRegistry({ appRoot }),
      "load",
      RESOLVED_CLIENT_PAGE_REGISTRY_ID,
    );

    // Parsed with the TypeScript plugin switched OFF: this throws if any type
    // annotation or type-only import survived.
    expect(() => parse(source, { sourceType: "module" })).not.toThrow();
    expect(source).not.toContain("import type");
  });

  it("zero pages is a legal empty registry, not an error", () => {
    const source = callHook<string>(
      clientPageRegistry({ appRoot: makeAppRoot() }),
      "load",
      RESOLVED_CLIENT_PAGE_REGISTRY_ID,
    );

    expect(source).toContain(`export const ${CLIENT_REGISTRY_EXPORT_NAME}`);
    expect(source).not.toContain(`import("`);
  });
});

/**
 * THE proof that matters. Everything above tests the plugin in isolation;
 * none of it says anything about what actually reaches the browser.
 *
 * The fixture page's `loader` — and only its `loader` — imports a module
 * carrying a marker string. If the page modules the registry names via
 * `import()` do NOT pass through `projection()`, that marker rides the
 * `loader` into the client bundle. Following `index.spec.ts`'s convention: a
 * real `vite.build()` through the real composed `warlockClientBoundary()`
 * array, asserting on the EMITTED output.
 */
const DB_MARKER = "WARLOCK_PROOF_DATABASE_SECRET_a1b2c3";
const COMPONENT_MARKER = "WARLOCK_PROOF_COMPONENT_TEXT_d4e5f6";

function makeProofAppRoot(): string {
  const appRoot = makeAppRoot();
  const webDir = path.join(appRoot, "src/app/blog/web");

  // A plain module inside the module's own web/ folder: Gate A permits this
  // import (rule 4's `$module/web/` allowance), so projection is the ONLY
  // thing that can keep the marker out of the client bundle. If the import
  // were, say, `./repository.server`, Gate A would refuse it and the test
  // would pass for the wrong reason.
  writeFile(
    path.join(webDir, "repository.ts"),
    `export const databaseSecret = ${JSON.stringify(DB_MARKER)};\n`,
  );

  writeFile(
    path.join(webDir, "article.page.tsx"),
    [
      `import { databaseSecret } from "./repository";`,
      ``,
      `export const route = { path: "/blog/article" };`,
      ``,
      `export const loader = async () => {`,
      `  return { secret: databaseSecret };`,
      `};`,
      ``,
      `export default function Article() {`,
      `  return ${JSON.stringify(COMPONENT_MARKER)};`,
      `}`,
      ``,
    ].join("\n"),
  );

  // Inside `src/web/` because Gate A's rule 4 refuses any local module outside
  // a `web/` folder — an entry at the app root is refused before the registry
  // is ever reached, which would make this a test of Gate A, not of projection.
  writeFile(
    path.join(appRoot, "src/web/entry.ts"),
    [
      `import { ${CLIENT_REGISTRY_EXPORT_NAME} } from ${JSON.stringify(CLIENT_PAGE_REGISTRY_ID)};`,
      ``,
      `export default ${CLIENT_REGISTRY_EXPORT_NAME};`,
      ``,
    ].join("\n"),
  );

  return appRoot;
}

/** Every emitted chunk's code, concatenated — the page is a dynamic-import chunk, not the entry chunk. */
function allEmittedCode(result: Awaited<ReturnType<typeof build>>): string {
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("expected rollup output in the build result");
  return output.output
    .map((chunk) => (chunk.type === "chunk" ? chunk.code : String(chunk.source)))
    .join("\n");
}

describe("clientPageRegistry — projection covers every module the registry imports (real vite build)", () => {
  it("the loader-only marker does NOT reach the client output, while the component's own text does", async () => {
    const appRoot = makeProofAppRoot();

    const result = await build({
      root: appRoot,
      logLevel: "silent",
      plugins: [warlockClientBoundary({ appRoot })],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(appRoot, "src/web/entry.ts"),
          formats: ["es"],
          fileName: () => "out.js",
        },
      },
    });

    const code = allEmittedCode(result);

    // Positive control: the page really was pulled into the graph via the
    // virtual registry's import(). Without this, "marker absent" would also
    // be satisfied by the page never being bundled at all.
    expect(code).toContain(COMPONENT_MARKER);
    expect(code).toContain("/blog/article");

    // The proof: projection stripped `loader`, which orphaned the
    // `./repository` import, so the database marker never reached the browser.
    expect(code).not.toContain(DB_MARKER);
    expect(code).not.toContain("databaseSecret");
  });

  it("counter-control: the SAME build without projection() ships the marker — so the proof above is projection's doing, not tree-shaking's", async () => {
    // Without this, "marker absent" would be satisfied just as well by Rollup
    // dropping an unreferenced `loader` on its own, and the test above would
    // pass forever while proving nothing about the boundary.
    const appRoot = makeProofAppRoot();

    const result = await build({
      root: appRoot,
      logLevel: "silent",
      plugins: [clientPageRegistry({ appRoot })],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(appRoot, "src/web/entry.ts"),
          formats: ["es"],
          fileName: () => "out.js",
        },
      },
    });

    const code = allEmittedCode(result);

    expect(code).toContain(COMPONENT_MARKER);
    expect(code).toContain(DB_MARKER);
  });
});
