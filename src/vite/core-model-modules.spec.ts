import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DevelopmentModelModuleEntry, DevelopmentModelModules } from "@warlock.js/core";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { coreModelModules } from "./core-model-modules";
import { warlockClientBoundary } from "./index";

class FixtureRegistry implements DevelopmentModelModules {
  private readonly entries = new Map<string, DevelopmentModelModuleEntry>();
  private readonly listeners = new Set<(entry: DevelopmentModelModuleEntry) => void>();

  public get(absolutePath: string): DevelopmentModelModuleEntry | undefined {
    return this.entries.get(path.resolve(absolutePath));
  }

  public subscribe(listener: (entry: DevelopmentModelModuleEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public publish(file: string, entry: DevelopmentModelModuleEntry): void {
    this.entries.set(path.resolve(file), entry);
    for (const listener of this.listeners) listener(entry);
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }
}

const temporaryDirectories: string[] = [];
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

function writeModel(file: string, revision: number): void {
  fs.writeFileSync(
    file,
    [
      `export const revision = ${revision};`,
      `export default class Model { static revision = ${revision}; }`,
    ].join("\n"),
    "utf8",
  );
}

describe("coreModelModules", () => {
  it("forwards model exports through Vite SSR across updates and removals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-core-model-modules-"));
    temporaryDirectories.push(root);
    const modelFile = path.join(root, "model.mjs");
    const pageFile = path.join(root, "page.mjs");
    const modelUrl = pathToFileURL(modelFile).href;
    const registry = new FixtureRegistry();
    writeModel(modelFile, 1);
    fs.writeFileSync(
      pageFile,
      `export { default as Model, revision } from "./model.mjs";\n`,
      "utf8",
    );
    registry.publish(modelFile, { url: modelUrl, generation: 1, hasDefault: true, state: "ready" });

    const vite: ViteDevServer = await createServer({
      root,
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [coreModelModules(registry)],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: false, watch: null },
    });

    try {
      const transformedModel = await vite.environments.ssr.transformRequest(modelFile);
      expect(transformedModel?.code).toContain("data:text/javascript");
      const firstVite = await vite.ssrLoadModule(pageFile);
      expect(firstVite.Model.revision).toBe(1);
      expect(firstVite.revision).toBe(1);

      writeModel(modelFile, 2);
      registry.publish(modelFile, {
        url: modelUrl,
        generation: 2,
        hasDefault: true,
        state: "ready",
      });
      const secondVite = await vite.ssrLoadModule(pageFile);
      expect(secondVite.Model).not.toBe(firstVite.Model);
      expect(secondVite.Model.revision).toBe(2);
      expect(secondVite.revision).toBe(2);

      registry.publish(modelFile, {
        url: modelUrl,
        generation: 3,
        hasDefault: false,
        state: "removed",
      });
      await expect(vite.ssrLoadModule(pageFile)).rejects.toThrow("Core model module was removed");

      writeModel(modelFile, 4);
      registry.publish(modelFile, {
        url: modelUrl,
        generation: 4,
        hasDefault: true,
        state: "ready",
      });
      const fourthVite = await vite.ssrLoadModule(pageFile);
      expect(fourthVite.Model.revision).toBe(4);

      const plugin = coreModelModules(registry);
      expect(
        await plugin.transform?.call(
          {},
          "export const untouched = true",
          path.join(root, "other.mjs"),
          { ssr: true },
        ),
      ).toBeNull();
      expect(
        await plugin.transform?.call({}, "export default 1", `${modelFile}?raw`, { ssr: true }),
      ).toBeNull();
      expect(
        await plugin.transform?.call({}, "export default 1", modelFile, { ssr: false }),
      ).toBeNull();
      expect(plugin.applyToEnvironment?.({ config: { consumer: "client" } } as never)).toBe(false);
      expect(plugin.applyToEnvironment?.({ config: { consumer: "server" } } as never)).toBe(true);
    } finally {
      await vite.close();
    }

    expect(registry.listenerCount).toBe(0);
  });

  it("leaves owned models visible to the composed client boundary before the SSR bridge", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-core-model-boundary-"));
    temporaryDirectories.push(root);
    const modelFile = path.join(root, "model.mjs");
    const retainedPage = path.join(root, "retained.page.tsx");
    const loaderOnlyPage = path.join(root, "loader-only.page.tsx");
    const registry = new FixtureRegistry();
    fs.writeFileSync(
      modelFile,
      `import { readFileSync } from "node:fs";\nexport const read = () => typeof readFileSync;\n`,
      "utf8",
    );
    fs.writeFileSync(
      retainedPage,
      `import { read } from "./model.mjs";\nexport default function Page() { return read(); }\n`,
      "utf8",
    );
    fs.writeFileSync(
      loaderOnlyPage,
      [
        `import { read } from "./model.mjs";`,
        `export const loader = () => read();`,
        `export default function Page() { return null; }`,
      ].join("\n"),
      "utf8",
    );
    registry.publish(modelFile, {
      url: pathToFileURL(modelFile).href,
      generation: 1,
      hasDefault: false,
      state: "ready",
    });

    const createBoundaryServer = () =>
      createServer({
        root,
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        plugins: [...warlockClientBoundary({ appRoot: root }), coreModelModules(registry)],
        resolve: {
          alias: {
            "@warlock.js/web/client/runtime": path.join(
              WEB_ROOT,
              "src",
              "client",
              "runtime",
              "index.ts",
            ),
          },
        },
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, watch: null },
      });

    const vite = await createBoundaryServer();

    try {
      await vite.environments.client.transformRequest(retainedPage);
      await expect(vite.environments.client.transformRequest(modelFile)).rejects.toThrow(
        "Node.js builtin module",
      );
      const loaderOnly = await vite.environments.client.transformRequest(loaderOnlyPage);
      expect(loaderOnly?.code).not.toContain("model.mjs");
    } finally {
      await vite.close();
    }

    const retainedSsr = await createBoundaryServer();
    try {
      await expect(retainedSsr.ssrLoadModule(retainedPage)).rejects.toThrow(
        "Node.js builtin module",
      );
    } finally {
      await retainedSsr.close();
    }

    const loaderOnlySsr = await createBoundaryServer();
    try {
      const page = await loaderOnlySsr.ssrLoadModule(loaderOnlyPage);
      expect(page.loader()).toBe("function");
    } finally {
      await loaderOnlySsr.close();
    }
  });
});
