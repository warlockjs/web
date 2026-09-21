/**
 * Card `2e1c18ac`: production build discovery must read pages from the SAME
 * custom `appSrcRoot` the dev client page registry uses, not from
 * `<appRoot>/src` by convention.
 *
 * The two pipelines take that root through different shapes. Dev
 * (`dev-server-config.ts`'s `createWebConnectorViteConfig`) takes
 * `appSrcRoot` as an ABSOLUTE path option and feeds `warlockClientBoundary`
 * `path.relative(options.appRoot, options.appSrcRoot)` directly. Production
 * (`contribution.ts`'s `WebBuildOptions.srcDir`, consumed by
 * `generate-pages-barrel.ts` / `discover-pages.ts` as
 * `path.join(appRoot, srcDir ?? "src")`) takes a NAME relative to `appRoot`.
 * A caller who points dev at a custom `appSrcRoot` and forgets to derive the
 * matching `srcDir` the same way gets a build that silently discovers zero
 * of the app's pages while dev serves them fine.
 *
 * Proven end to end against the SAME appRoot/appSrcRoot/page file: dev finds
 * it through a real Vite dev-server transform (the same proof
 * `dev-server-config.spec.ts`'s own "custom appSrcRoot" describe block
 * gives), production finds it through the real, unmocked barrel generator
 * when `srcDir` is derived with the identical
 * `path.relative(appRoot, appSrcRoot)` expression dev-server-config.ts uses.
 */
import { createServer as createNodeServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorBuildContext } from "@warlock.js/core";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebConnectorViteConfig } from "../vite/dev-server-config";
import { RESOLVED_CLIENT_PAGE_REGISTRY_ID } from "../vite/page-registry-plugin";
import { createWebBuildContribution } from "./contribution";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = path.resolve(WEB_ROOT, "..");

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function buildContext(appRoot: string): ConnectorBuildContext {
  return {
    appRoot,
    productionDir: path.join(appRoot, ".warlock", "production"),
    options: { outdir: path.join(appRoot, "dist") } as ConnectorBuildContext["options"],
  };
}

describe("production build discovery honours the same custom appSrcRoot as the dev client registry (card 2e1c18ac)", () => {
  it("finds the same page whether reached through dev's absolute appSrcRoot or production's derived srcDir", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-appsrcroot-parity-"));
    temporaryDirectories.push(appRoot);

    const appSrcRoot = path.join(appRoot, "custom-src");
    const pageFile = path.join(appSrcRoot, "web", "home.page.tsx");

    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(
      pageFile,
      [
        `export const config = { route: { path: "/home" } };`,
        `export default function Home() { return null; }`,
      ].join("\n"),
      "utf-8",
    );
    // Routable pages require the app root component to exist — the same
    // requirement `generatePagesBarrel` enforces for a normal `src/` tree.
    fs.writeFileSync(
      path.join(appSrcRoot, "web", "root.tsx"),
      "export default function App() { return null; }\n",
      "utf-8",
    );

    // --- Dev half: appSrcRoot passed directly, as an absolute path. ---
    const hmrServer = createNodeServer();
    const devConfig = await createWebConnectorViteConfig({
      appRoot,
      appSrcRoot,
      webRoot: WEB_ROOT,
      workspaceRoot: WORKSPACE_ROOT,
      hmrServer,
      handlePageHotUpdate: async () => false,
      leadingPlugins: [],
    });

    const vite: ViteDevServer = await createServer({
      ...devConfig,
      configFile: false,
      logLevel: "silent",
      optimizeDeps: { ...devConfig.optimizeDeps, noDiscovery: true, include: [] },
      server: { ...devConfig.server, hmr: false, watch: null },
    });

    let devFoundPage: boolean;

    try {
      const result = await vite.environments.client.transformRequest(
        RESOLVED_CLIENT_PAGE_REGISTRY_ID,
      );
      devFoundPage = Boolean(result?.code?.includes(path.basename(pageFile)));
    } finally {
      await vite.close();
      hmrServer.close();
    }

    expect(devFoundPage).toBe(true);

    // --- Production half: the SAME appSrcRoot, expressed the only way
    // `WebBuildOptions.srcDir` accepts it — a name relative to `appRoot`,
    // derived with the identical expression dev-server-config.ts uses. ---
    const srcDir = path.relative(appRoot, appSrcRoot);
    const context = buildContext(appRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createWebBuildContribution({ srcDir }).generate?.(context);
    log.mockRestore();

    const barrel = fs.readFileSync(path.join(context.productionDir, "pages.ts"), "utf-8");

    expect(barrel).toContain("home.page");
  });

  it("discovers nothing under appRoot's default src/ once a custom srcDir wins — proving srcDir, not a hand-picked fallback, drove the match above", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-appsrcroot-parity-negative-"));
    temporaryDirectories.push(appRoot);

    const appSrcRoot = path.join(appRoot, "custom-src");
    const pageFile = path.join(appSrcRoot, "web", "home.page.tsx");

    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    fs.writeFileSync(
      pageFile,
      [
        `export const config = { route: { path: "/home" } };`,
        `export default function Home() { return null; }`,
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(appSrcRoot, "web", "root.tsx"),
      "export default function App() { return null; }\n",
      "utf-8",
    );

    const context = buildContext(appRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // No `srcDir` option: falls back to the default `<appRoot>/src`, which
    // this fixture never populated.
    const result = await createWebBuildContribution().generate?.(context);
    log.mockRestore();

    expect(result).toMatchObject({ entryImports: expect.any(Array) });

    const barrel = fs.readFileSync(path.join(context.productionDir, "pages.ts"), "utf-8");

    expect(barrel).not.toContain("home.page");
  });
});
