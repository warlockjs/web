/**
 * `warlock dev`'s Vite server must not share `node_modules/.vite` with the
 * other Vite processes of the same app.
 *
 * A vitest run in the app re-optimizes dependencies into Vite's default cache
 * directory; when that is also the dev server's directory, the run wipes the
 * optimized deps the dev server is serving and every SSR page answers 500 until
 * restart. These specs read the config the connector really hands to
 * `createServer`.
 */
import { createServer as createNodeServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createWebConnectorViteConfig, webDevServerCacheDir } from "./dev-server-config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..", "..");

async function devConfig(appRoot: string) {
  return createWebConnectorViteConfig({
    appRoot,
    appSrcRoot: path.join(appRoot, "src"),
    webRoot: WEB_ROOT,
    workspaceRoot: path.resolve(WEB_ROOT, ".."),
    hmrServer: createNodeServer(),
    handlePageHotUpdate: async () => false,
    leadingPlugins: [],
  });
}

describe("dev server Vite config — its own cacheDir", () => {
  it("uses <appRoot>/node_modules/.vite/warlock-dev", async () => {
    const appRoot = path.resolve(WEB_ROOT, "..", "some-app");
    const config = await devConfig(appRoot);

    expect(config.cacheDir).toBe(path.join(appRoot, "node_modules", ".vite", "warlock-dev"));
  });

  it("is never Vite's shared default directory, which vitest and other Vite processes use", async () => {
    const appRoot = path.resolve(WEB_ROOT, "..", "some-app");
    const config = await devConfig(appRoot);
    const sharedDefault = path.join(appRoot, "node_modules", ".vite");

    expect(config.cacheDir).not.toBe(sharedDefault);
    // Nested under it, so one `.vite` stays the only artefact in node_modules,
    // but a different directory: neither side can wipe the other's files.
    expect(path.relative(sharedDefault, config.cacheDir as string)).toBe("warlock-dev");
  });

  it("resolves a relative appRoot to an absolute directory", () => {
    expect(path.isAbsolute(webDevServerCacheDir("."))).toBe(true);
  });
});
