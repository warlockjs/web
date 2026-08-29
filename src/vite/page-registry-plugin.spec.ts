import { parse } from "@babel/parser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Plugin } from "vite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLIENT_REGISTRY_EXPORT_NAME } from "../build/generate-client-registry";
import { warlockClientBoundary } from "./index";
import {
  CLIENT_PAGE_REGISTRY_ID,
  clientPageRegistry,
  invalidateClientPageRegistry,
  RESOLVED_CLIENT_PAGE_REGISTRY_ID,
} from "./page-registry-plugin";
import { projectModule } from "./projection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/** Invokes a plugin hook with an explicit `this` (for `transform`/`hotUpdate`, which read `this.environment`). */
function callHookWith<T>(plugin: Plugin, hook: "transform" | "hotUpdate", thisArg: any, ...args: any[]): T {
  const handler = plugin[hook];
  const fn = typeof handler === "function" ? handler : (handler as any)?.handler;
  return fn.apply(thisArg, args) as T;
}

/** The one page shape the reload seam cares about: a client component plus a server `metadata` export. */
function metadataPageSource(routePath: string, title: string, bodyText: string): string {
  return [
    `export const route = { path: ${JSON.stringify(routePath)} };`,
    ``,
    `export const metadata = { title: ${JSON.stringify(title)} };`,
    ``,
    `export default function Page() {`,
    `  return ${JSON.stringify(bodyText)};`,
    `}`,
    ``,
  ].join("\n");
}

function registerPageSource(signature: string, registerBody: string, componentText: string): string {
  return [
    `export const route = { path: "/registered" };`,
    ``,
    `export function register${signature} {`,
    `  ${registerBody}`,
    `}`,
    ``,
    `export default function Page() {`,
    `  return ${JSON.stringify(componentText)};`,
    `}`,
    ``,
  ].join("\n");
}

function constRegisterPageSource(registerBody: string, componentText: string): string {
  return [
    `export const route = { path: "/registered" };`,
    ``,
    `export const register = () => {`,
    `  ${registerBody}`,
    `};`,
    ``,
    `export default function Page() {`,
    `  return ${JSON.stringify(componentText)};`,
    `}`,
    ``,
  ].join("\n");
}

function declaredRegisterPageSource(declaration: string, componentText: string): string {
  return [
    `export const route = { path: "/registered" };`,
    ``,
    declaration,
    ``,
    `export default function Page() {`,
    `  return ${JSON.stringify(componentText)};`,
    `}`,
    ``,
  ].join("\n");
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
      path.join(appRoot, "src/web/blog/article.page.tsx"),
      pageSource("/blog/article", "export default function Article() {\n  return null;\n}\n"),
    );
    writeFile(
      path.join(appRoot, "src/web/shop/item.page.tsx"),
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

describe("invalidateClientPageRegistry", () => {
  function viteWithRegistryNode(registryNode: object | undefined) {
    const getModuleById = vi.fn(() => registryNode);
    const invalidateModule = vi.fn();
    const send = vi.fn();
    const vite = {
      environments: { client: { moduleGraph: { getModuleById, invalidateModule } } },
      hot: { send },
    } as any;

    return { vite, getModuleById, invalidateModule, send };
  }

  it("looks up and invalidates only the resolved client registry node, then sends one full reload", () => {
    const registryNode = { id: RESOLVED_CLIENT_PAGE_REGISTRY_ID };
    const { vite, getModuleById, invalidateModule, send } = viteWithRegistryNode(registryNode);

    invalidateClientPageRegistry(vite);

    expect(getModuleById).toHaveBeenCalledOnce();
    expect(getModuleById).toHaveBeenCalledWith(RESOLVED_CLIENT_PAGE_REGISTRY_ID);
    expect(invalidateModule).toHaveBeenCalledOnce();
    expect(invalidateModule).toHaveBeenCalledWith(registryNode);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
  });

  it("still sends one full reload when the registry node is absent", () => {
    const { vite, getModuleById, invalidateModule, send } = viteWithRegistryNode(undefined);

    expect(() => invalidateClientPageRegistry(vite)).not.toThrow();

    expect(getModuleById).toHaveBeenCalledWith(RESOLVED_CLIENT_PAGE_REGISTRY_ID);
    expect(invalidateModule).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
  });

  it("generates registry content from the page tree after add/delete invalidation", () => {
    const appRoot = makeAppRoot();
    const deletedPage = path.join(appRoot, "src/web/deleted.page.tsx");
    const addedPage = path.join(appRoot, "src/web/added.page.tsx");
    const plugin = clientPageRegistry({ appRoot });
    const registryNode = { id: RESOLVED_CLIENT_PAGE_REGISTRY_ID };
    const { vite, invalidateModule, send } = viteWithRegistryNode(registryNode);

    writeFile(
      deletedPage,
      pageSource("/deleted", "export default function Deleted() {\n  return null;\n}\n"),
    );
    const before = callHook<string>(plugin, "load", RESOLVED_CLIENT_PAGE_REGISTRY_ID);
    expect(before).toContain(`path: "/deleted"`);
    expect(before).not.toContain(`path: "/added"`);

    fs.unlinkSync(deletedPage);
    writeFile(
      addedPage,
      pageSource("/added", "export default function Added() {\n  return null;\n}\n"),
    );
    invalidateClientPageRegistry(vite);

    const after = callHook<string>(plugin, "load", RESOLVED_CLIENT_PAGE_REGISTRY_ID);
    expect(after).toContain(`path: "/added"`);
    expect(after).not.toContain(`path: "/deleted"`);
    expect(invalidateModule).toHaveBeenCalledWith(registryNode);
    expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" });
  });
});

/**
 * The server-vs-client reload seam. `transform` captures the module SKELETON
 * (the source with every component and exported `register` body masked) as the
 * "before"; `hotUpdate` compares the "after". Anything that moves outside
 * those bodies — an import, a module-level declaration, a register signature,
 * or any server export — forces a full reload. Body-only changes fall through
 * to the projected module's self-accept and React Fast Refresh untouched.
 */
describe("clientPageRegistry — the server half wins: metadata edits force a full reload, pure JSX edits do not", () => {
  const PAGE = "/app/blog/web/article.page.tsx";

  /** A `this` for `transform`: dev mode so the capture spy is active. */
  function transformContext() {
    return { environment: { mode: "dev" } };
  }

  /** A `this` for `hotUpdate`: records every payload the plugin sends. */
  function hotUpdateContext() {
    const sent: any[] = [];
    return {
      thisArg: { environment: { mode: "dev", hot: { send: (payload: any) => sent.push(payload) } } },
      sent,
    };
  }

  function hotUpdateOptions(file: string, source: string) {
    return { type: "update" as const, file, timestamp: 1, modules: [], read: () => source, server: {} as any };
  }

  it("the capture spy returns nothing (projection still owns the real transform) and only runs in dev", () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    const source = metadataPageSource("/blog/article", "First", "hello");

    // Dev: captures, but returns undefined so projection's transform is untouched.
    expect(callHookWith(plugin, "transform", transformContext(), source, PAGE)).toBeUndefined();
    // Build (`mode !== "dev"`): skipped entirely — serve-only.
    expect(
      callHookWith(plugin, "transform", { environment: { mode: "build" } }, source, PAGE),
    ).toBeUndefined();
    // Not a page module: ignored.
    expect(callHookWith(plugin, "transform", transformContext(), source, "/app/util.ts")).toBeUndefined();
  });

  it("a metadata-only edit (projected client code unchanged) sends full-reload and suppresses the Fast Refresh update", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });

    // Baseline capture, then edit ONLY the server `metadata` title.
    callHookWith(plugin, "transform", transformContext(), metadataPageSource("/blog/article", "First", "hello"), PAGE);
    const edited = metadataPageSource("/blog/article", "Second", "hello");

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(plugin, "hotUpdate", thisArg, hotUpdateOptions(PAGE, edited));

    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    // Empty array: the plugin owns this update, Vite must not also Fast-Refresh.
    expect(result).toEqual([]);
  });

  it("waits for live route publication and does not send a duplicate reload when it was handled", async () => {
    const order: string[] = [];
    const plugin = clientPageRegistry({
      appRoot: makeAppRoot(),
      beforePageHotUpdate: async ({ file, type }) => {
        order.push(`routes:${type}:${file}`);
        return true;
      },
    });
    const source = metadataPageSource("/blog/article", "First", "hello");
    callHookWith(plugin, "transform", transformContext(), source, PAGE);

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(PAGE, metadataPageSource("/renamed", "First", "hello")),
    );

    expect(order).toEqual([`routes:update:${PAGE}`]);
    expect(sent).toEqual([]);
    expect(result).toEqual([]);
  });

  it("a JSX edit (projected client code changed) sends nothing and defers to Fast Refresh", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });

    callHookWith(plugin, "transform", transformContext(), metadataPageSource("/blog/article", "First", "hello"), PAGE);
    // Same metadata, DIFFERENT component text — the client half moves.
    const edited = metadataPageSource("/blog/article", "First", "goodbye");

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(plugin, "hotUpdate", thisArg, hotUpdateOptions(PAGE, edited));

    expect(sent).toEqual([]);
    // No return value: Vite performs its normal Fast Refresh update.
    expect(result).toBeUndefined();
  });

  it("a register function body edit sends nothing and defers to the projected self-accept", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(plugin, "transform", transformContext(), registerPageSource("()", "installFirst();", "hello"), PAGE);

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(PAGE, registerPageSource("()", "installSecond();", "hello")),
    );

    expect(sent).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("a register and component body edit in one save defers to self-accept and Fast Refresh", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(plugin, "transform", transformContext(), registerPageSource("()", "installFirst();", "hello"), PAGE);

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(PAGE, registerPageSource("()", "installSecond();", "goodbye")),
    );

    expect(sent).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("masks the body of a one-declarator exported const register", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(plugin, "transform", transformContext(), constRegisterPageSource("installFirst();", "hello"), PAGE);

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(PAGE, constRegisterPageSource("installSecond();", "hello")),
    );

    expect(sent).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("a register signature edit forces a full reload", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(plugin, "transform", transformContext(), registerPageSource("()", "install();", "hello"), PAGE);

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(PAGE, registerPageSource("(scope: string)", "install();", "hello")),
    );

    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("does not mask a non-exported register body", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(
      plugin,
      "transform",
      transformContext(),
      declaredRegisterPageSource(`function register() { installFirst(); }`, "hello"),
      PAGE,
    );

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(
        PAGE,
        declaredRegisterPageSource(`function register() { installSecond(); }`, "hello"),
      ),
    );

    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("does not mask register inside a multi-declarator export", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(
      plugin,
      "transform",
      transformContext(),
      declaredRegisterPageSource(`export const register = () => { installFirst(); }, version = 1;`, "hello"),
      PAGE,
    );

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(
      plugin,
      "hotUpdate",
      thisArg,
      hotUpdateOptions(
        PAGE,
        declaredRegisterPageSource(`export const register = () => { installSecond(); }, version = 1;`, "hello"),
      ),
    );

    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("a mixed edit (BOTH metadata and JSX changed in one save) reloads — the server half wins over Fast Refresh", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });

    callHookWith(plugin, "transform", transformContext(), metadataPageSource("/blog/article", "First", "hello"), PAGE);
    // ONE save that moves BOTH halves: the `metadata` title AND the component text.
    const edited = metadataPageSource("/blog/article", "Second", "goodbye");

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(plugin, "hotUpdate", thisArg, hotUpdateOptions(PAGE, edited));

    // The client half moved too, yet the stale `<head>` must never ship: the
    // server-half change forces a full reload and suppresses the Fast Refresh.
    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("an identical re-save (neither half changed) forces nothing", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });

    const source = metadataPageSource("/blog/article", "First", "hello");
    callHookWith(plugin, "transform", transformContext(), source, PAGE);

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(plugin, "hotUpdate", thisArg, hotUpdateOptions(PAGE, source));

    expect(sent).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("no captured baseline (first edit unseen by the spy) does not force a reload", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    const edited = metadataPageSource("/blog/article", "Second", "hello");

    const { thisArg, sent } = hotUpdateContext();
    const result = await callHookWith<Promise<any>>(plugin, "hotUpdate", thisArg, hotUpdateOptions(PAGE, edited));

    expect(sent).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("non-page files and create/delete events are ignored", async () => {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    const source = metadataPageSource("/blog/article", "First", "hello");

    const nonPage = hotUpdateContext();
    expect(
      await callHookWith<Promise<any>>(plugin, "hotUpdate", nonPage.thisArg, hotUpdateOptions("/app/util.ts", source)),
    ).toBeUndefined();
    expect(nonPage.sent).toEqual([]);

    // Even on a real page, a non-`update` event is left to Vite.
    callHookWith(plugin, "transform", transformContext(), source, PAGE);
    const created = hotUpdateContext();
    expect(
      await callHookWith<Promise<any>>(plugin, "hotUpdate", created.thisArg, {
        ...hotUpdateOptions(PAGE, source),
        type: "create",
      }),
    ).toBeUndefined();
    expect(created.sent).toEqual([]);
  });
});

/**
 * The three shapes that defeated the two earlier cuts of this seam, each
 * pinned against the REAL `projectModule` so the spec proves the trap exists
 * rather than asserting it from memory.
 *
 * For every case below the spec first MEASURES the two signals the earlier
 * cuts used —
 *
 *   - the projected CLIENT code (cut 1: "unchanged projection ⇒ reload"), and
 *   - its complement, the stripped SERVER half (cut 2: "complement moved ⇒
 *     reload"),
 *
 * — and only then asserts the plugin's decision. Cases 2 and 3 are exactly the
 * saves where both of those signals say "Fast Refresh" and the honest answer
 * is "reload": an import, or a module-level local, read by BOTH `metadata` and
 * the JSX survives projection whole, so it lives in the client half and in
 * NEITHER half exclusively. If someone later replaces the skeleton with a
 * cleverer half-splitter, these three fail first.
 */
describe("clientPageRegistry — shared imports and locals reload (measured against the real projectModule)", () => {
  const PAGE = "/app/blog/web/article.page.tsx";

  /**
   * Cut 2's server half: the bytes projection removed, recovered by the same
   * greedy subsequence walk it used. Kept HERE, in the spec, purely to measure
   * the old signal — the plugin no longer computes it, because computing it
   * was the bug.
   */
  function strippedComplement(full: string, client: string): string {
    const removed: string[] = [];
    let clientIndex = 0;
    for (let i = 0; i < full.length; i++) {
      if (clientIndex < client.length && full[i] === client[clientIndex]) clientIndex++;
      else removed.push(full[i]);
    }
    return removed.join("");
  }

  /** Both signals the earlier cuts compared, from the real projection. */
  function halves(source: string) {
    const client = projectModule(source, PAGE).code;
    return { client, server: strippedComplement(source, client) };
  }

  /** Runs one edit through the plugin end to end and reports what it sent and returned. */
  async function applyEdit(before: string, after: string) {
    const plugin = clientPageRegistry({ appRoot: makeAppRoot() });
    callHookWith(plugin, "transform", { environment: { mode: "dev" } }, before, PAGE);

    const sent: any[] = [];
    const thisArg = {
      environment: { mode: "dev", hot: { send: (payload: any) => sent.push(payload) } },
    };
    const result = await callHookWith<Promise<any>>(plugin, "hotUpdate", thisArg, {
      type: "update" as const,
      file: PAGE,
      timestamp: 1,
      modules: [],
      read: () => after,
      server: {} as any,
    });

    return { sent, result };
  }

  /** A page whose `metadata` and whose JSX both read the SAME imported symbol. */
  function sharedImportPage(specifier: string): string {
    return [
      `import { pageTitle } from ${JSON.stringify(specifier)};`,
      ``,
      `export const route = { path: "/blog/article" };`,
      ``,
      `export const metadata = { title: pageTitle };`,
      ``,
      `export default function Page() {`,
      `  return pageTitle;`,
      `}`,
      ``,
    ].join("\n");
  }

  /** A page whose `metadata` and whose JSX both read the SAME module-level local. */
  function sharedLocalPage(value: string): string {
    return [
      `const pageTitle = ${JSON.stringify(value)};`,
      ``,
      `export const route = { path: "/blog/article" };`,
      ``,
      `export const metadata = { title: pageTitle };`,
      ``,
      `export default function Page() {`,
      `  return pageTitle;`,
      `}`,
      ``,
    ].join("\n");
  }

  it("case 3 — a mixed save (JSX AND metadata) reloads, even though the projected client code moved", async () => {
    const before = metadataPageSource("/blog/article", "First", "hello");
    const after = metadataPageSource("/blog/article", "Second", "goodbye");

    // Cut 1's signal says "the client half moved, so this is a JSX edit" — the
    // exact misreading that shipped a stale `<head>` on mixed saves.
    expect(halves(before).client).not.toBe(halves(after).client);

    const { sent, result } = await applyEdit(before, after);
    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("case 4 — changing ONLY the specifier of an import read by both metadata and the JSX reloads", async () => {
    const before = sharedImportPage("./a");
    const after = sharedImportPage("./b");

    // `projection.ts:447-448` KEEPS the import because the client reads it, so
    // the specifier change lands entirely in the client half and the
    // complement is byte-identical. BOTH earlier cuts read this as a pure JSX
    // edit and Fast-Refreshed a stale `<title>`.
    expect(halves(before).client).toContain(`"./a"`);
    expect(halves(after).client).toContain(`"./b"`);
    expect(halves(before).server).toBe(halves(after).server);

    const { sent, result } = await applyEdit(before, after);
    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("case 5 — changing a module-level local read by both metadata and the JSX reloads", async () => {
    const before = sharedLocalPage("First");
    const after = sharedLocalPage("Second");

    // Same shape as case 4, one binding kind over: a surviving reader keeps the
    // local in the client half, so the complement never moves. Extending the
    // complement to cover imports would NOT have caught this one.
    expect(halves(before).server).toBe(halves(after).server);

    const { sent, result } = await applyEdit(before, after);
    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("a PascalCase helper that `metadata` can reach is not a component: editing its body reloads", async () => {
    // The one hole a bare "mask every PascalCase function" rule would leave.
    // `serverReachableNames` unmasks it, so the change is compared verbatim.
    const page = (suffix: string) =>
      [
        `const Title = () => "First" + ${JSON.stringify(suffix)};`,
        ``,
        `export const route = { path: "/blog/article" };`,
        ``,
        `export const metadata = { title: Title() };`,
        ``,
        `export default function Page() {`,
        `  return "body";`,
        `}`,
        ``,
      ].join("\n");

    const { sent, result } = await applyEdit(page("!"), page("?"));
    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("the accepted cost: editing a module-level helper read only by the JSX also reloads", async () => {
    // Deliberate over-approximation. A needless reload costs component state;
    // a missed one ships a stale `<head>`. Precise reachability is a later
    // refinement — this spec exists so removing it is a conscious act.
    const page = (greeting: string) =>
      [
        `const greet = () => ${JSON.stringify(greeting)};`,
        ``,
        `export const route = { path: "/blog/article" };`,
        ``,
        `export const metadata = { title: "First" };`,
        ``,
        `export default function Page() {`,
        `  return greet();`,
        `}`,
        ``,
      ].join("\n");

    const { sent, result } = await applyEdit(page("hello"), page("goodbye"));
    expect(sent).toEqual([{ type: "full-reload", path: "*" }]);
    expect(result).toEqual([]);
  });

  it("what must NOT regress: a JSX-only edit inside a sub-component body still defers to Fast Refresh", async () => {
    // The always-reload shortcut passes every case above and destroys Fast
    // Refresh — the exact defect this seam exists to avoid. Component bodies,
    // including a sibling component's, are the one thing that may hot-swap.
    const page = (rowText: string) =>
      [
        `import { Card } from "./card";`,
        ``,
        `export const route = { path: "/blog/article" };`,
        ``,
        `export const metadata = { title: "First" };`,
        ``,
        `function Row() {`,
        `  return ${JSON.stringify(rowText)};`,
        `}`,
        ``,
        `export default function Page() {`,
        `  return <Card>{Row()}</Card>;`,
        `}`,
        ``,
      ].join("\n");

    const { sent, result } = await applyEdit(page("one"), page("two"));
    expect(sent).toEqual([]);
    expect(result).toBeUndefined();
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
  const webDir = path.join(appRoot, "src/web/blog");

  // A plain module inside the app's web/ folder: Gate A permits this
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
      // `appRoot` is a bare temp directory with no `package.json` of its own, so
      // Node's self-reference resolution (which `index.spec.ts`'s in-repo
      // fixtures get for free by walking up to `web/package.json`) never finds
      // this package's name here. `projection()`'s HMR wrapper imports
      // `@warlock.js/web/client/runtime` unconditionally, so the build needs an
      // explicit alias to the real source instead.
      resolve: {
        alias: {
          "@warlock.js/web/client/runtime": path.join(
            __dirname,
            "..",
            "client",
            "runtime",
            "index.ts",
          ),
        },
      },
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
