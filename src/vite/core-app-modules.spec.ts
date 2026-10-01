import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appConventionAliases } from "./app-convention-aliases";
import { coreAppModules, requiresViteToEvaluate } from "./core-app-modules";
import { moduleKey } from "../shared/module-key";
import { createSsrBoundaryState, isClientBoundModule } from "./ssr-client-view";
import { warlockClientBoundary } from "./index";

/**
 * The 5.28 dev-module-graph fix, proved against the REAL pieces rather than
 * stand-ins: core's real `FilesOrchestrator` registers the real ESM loader hook
 * in this process, `import()` below is Node's own (so it goes through that
 * hook and its `?v=N` cache), and the other side is a real Vite dev server
 * evaluating through its SSR module runner. The identity of an object exported
 * by a `src/app` module is the observable: two instances would mean a split
 * `AsyncLocalStorage`, cache or registry.
 */

type Bridge = {
  als: unknown;
  default?: { revision: number };
  revision: number;
};

type Orchestrator = {
  init(): Promise<void>;
  bumpVersion(absolutePath: string): void;
  flushVersionBumps(): Promise<void>;
};

/**
 * Node's own `import()`. This spec runs inside Vitest, whose module runner
 * would turn a plain `import(url)` into a graph-local import that never reaches
 * Node's loader hook. A CommonJS file loaded through `createRequire` is
 * compiled by Node itself, so its `import()` is the real native one.
 */
let nativeImport: (url: string) => Promise<Bridge>;

const originalCwd = process.cwd();
let root: string;
let orchestrator: Orchestrator;
let registry: import("@warlock.js/core").DevelopmentAppModules;

function appFile(...segments: string[]): string {
  return path.join(root, "src", "app", ...segments);
}

function writeApp(file: string, revision: number, withDefault = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      `import { AsyncLocalStorage } from "node:async_hooks";`,
      `export const als = new AsyncLocalStorage<string>();`,
      `export const revision = ${revision};`,
      withDefault ? `export default { revision: ${revision} };` : ``,
    ].join("\n"),
    "utf8",
  );
}

/** Edit the file the way the dev server sees it: bump, then flush the hook thread. */
async function bump(file: string): Promise<void> {
  orchestrator.bumpVersion(file);
  await orchestrator.flushVersionBumps();
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function createViteServer(
  plugins: import("vite").Plugin[],
  extraAlias: import("vite").Alias[] = [],
): Promise<ViteDevServer> {
  return createServer({
    root,
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins,
    resolve: { alias: [...extraAlias, ...appConventionAliases(path.join(root, "src"))] },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "warlock-core-app-modules-")));
  fs.writeFileSync(path.join(root, "package.json"), `{ "name": "fixture", "type": "module" }`);
  fs.writeFileSync(path.join(root, "warlock.config.ts"), "export default {};");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "app/*": ["src/app/*"], "web/*": ["src/web/*"] },
      },
    }),
  );

  // Core resolves the loader hook's `src` root and `.warlock/` from the cwd, so
  // the real orchestrator must be created from inside the fixture app.
  fs.writeFileSync(path.join(root, "native-import.cjs"), "module.exports = (url) => import(url);");
  nativeImport = createRequire(path.join(root, "x.cjs"))("./native-import.cjs");

  process.chdir(root);
  const orchestratorModule = await import("@warlock.js/core/src/dev-server/files-orchestrator");
  const registryModule = await import("@warlock.js/core/src/dev-server/app-module-registry");
  orchestrator = new orchestratorModule.FilesOrchestrator() as unknown as Orchestrator;
  registry = registryModule.getDevelopmentAppModuleRegistry();
  await orchestrator.init();
}, 120_000);

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows keeps the loader-hook thread's handle on the fixture open until exit.
  }
});

describe("coreAppModules", () => {
  it("makes Vite SSR and core's native loader share one instance of a src/app module, across edits", async () => {
    const alsFile = appFile("shared", "als.ts");
    const plainFile = appFile("shared", "plain.ts");
    const probeFile = path.join(root, "src", "web", "probe.ts");
    writeApp(alsFile, 1);
    writeApp(plainFile, 1, false);
    fs.mkdirSync(path.dirname(probeFile), { recursive: true });
    fs.writeFileSync(
      probeFile,
      [
        `export { als, revision } from "app/shared/als";`,
        `export { default } from "app/shared/als";`,
        `export { als as plainAls, revision as plainRevision } from "app/shared/plain";`,
      ].join("\n"),
      "utf8",
    );

    const vite = await createViteServer([coreAppModules({ appSrcRoot: path.join(root, "src"), registry, nativeImport })]);

    try {
      const alsUrl = pathToFileURL(alsFile).href;
      const nativeBefore = await nativeImport(alsUrl);
      const viteBefore = (await vite.ssrLoadModule(probeFile)) as Bridge & { plainAls: unknown };
      const viteDirectBefore = (await vite.ssrLoadModule(alsFile)) as Bridge;

      expect(nativeBefore.revision).toBe(1);
      expect(viteBefore.als).toBe(nativeBefore.als);
      expect(viteDirectBefore.als).toBe(nativeBefore.als);
      expect(viteBefore.default).toBe(nativeBefore.default);
      // A module with no default export must not get a `default` re-export.
      expect(viteBefore.plainAls).toBe((await nativeImport(pathToFileURL(plainFile).href)).als);

      // The real edit path: new content, bump, ack from the hook thread.
      writeApp(alsFile, 2);
      await bump(alsFile);
      expect(registry.get(alsFile)?.generation).toBe(1);

      const nativeAfter = await nativeImport(alsUrl);
      const viteAfter = (await vite.ssrLoadModule(probeFile)) as Bridge;

      expect(nativeAfter.revision).toBe(2);
      expect(nativeAfter.als).not.toBe(nativeBefore.als);
      expect(viteAfter.revision).toBe(2);
      expect(viteAfter.als).toBe(nativeAfter.als);
      expect(viteAfter.default).toBe(nativeAfter.default);

      // And again: the generation keeps tracking the hook's version.
      writeApp(alsFile, 3);
      await bump(alsFile);
      const nativeThird = await nativeImport(alsUrl);
      expect(registry.get(alsFile)?.generation).toBe(2);
      expect(((await vite.ssrLoadModule(probeFile)) as Bridge).als).toBe(nativeThird.als);
    } finally {
      await vite.close();
    }
  }, 60_000);

  it("control: without the plugin Vite evaluates its own second copy", async () => {
    const alsFile = appFile("shared", "als-control.ts");
    const probeFile = path.join(root, "src", "web", "probe-control.ts");
    writeApp(alsFile, 1);
    fs.writeFileSync(probeFile, `export { als } from "app/shared/als-control";`, "utf8");

    const vite = await createViteServer([]);

    try {
      const native = await nativeImport(pathToFileURL(alsFile).href);
      const inVite = (await vite.ssrLoadModule(probeFile)) as Bridge;

      expect(inVite.als).toBeDefined();
      expect(inVite.als).not.toBe(native.als);
    } finally {
      await vite.close();
    }
  }, 60_000);

  it("leaves src/web, client, queried, client-bound and Vite-only modules inside Vite", async () => {
    const webDirectory = path.join(root, "src", "web");
    const keep = {
      web: path.join(webDirectory, "component.ts"),
      client: appFile("shared", "thing.client.ts"),
      viteOnly: appFile("shared", "env-reader.ts"),
      stylesheet: appFile("shared", "styled.ts"),
      clientBound: appFile("shared", "client-bound.ts"),
      js: appFile("shared", "plain.js"),
    };
    fs.mkdirSync(webDirectory, { recursive: true });
    fs.writeFileSync(keep.web, `export const marker = "web";`, "utf8");
    fs.writeFileSync(keep.client, `export const marker = "client";`, "utf8");
    fs.writeFileSync(keep.viteOnly, `export const mode = import.meta.env.MODE;`, "utf8");
    fs.writeFileSync(keep.stylesheet, `import "./styled.css";\nexport const marker = "css";`, "utf8");
    fs.writeFileSync(path.join(path.dirname(keep.stylesheet), "styled.css"), `a{color:red}`, "utf8");
    fs.writeFileSync(keep.clientBound, `export const marker = "bound";`, "utf8");
    fs.writeFileSync(keep.js, `export const marker = "js";`, "utf8");

    // The boundary mirror warns about a `.client` file reached with no importer.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = createSsrBoundaryState(root);
    const vite = await createViteServer([
      ...warlockClientBoundary({ appRoot: root, ssrState: state }),
      coreAppModules({
        appSrcRoot: path.join(root, "src"),
        registry,
        nativeImport,
        isClientBound: (id) => isClientBoundModule(state, id),
      }),
    ]);

    try {
      state.clientBoundModules.add(moduleKey(keep.clientBound));

      for (const file of Object.values(keep)) {
        const transformed = await vite.environments.ssr.transformRequest(file);
        expect(transformed?.code, file).not.toContain("data:text/javascript");
      }

      // Control: an unmarked sibling IS bridged by the same server.
      const bridged = appFile("shared", "bridged.ts");
      writeApp(bridged, 1);
      const transformed = await vite.environments.ssr.transformRequest(bridged);
      expect(transformed?.code).toContain("data:text/javascript");
      // A queried id is a different module and is never bridged.
      const queried = await vite.environments.ssr.transformRequest(`${bridged}?inline`);
      expect(queried?.code ?? "").not.toContain("data:text/javascript");
    } finally {
      vi.restoreAllMocks();
      await vite.close();
    }
  }, 60_000);

  it("keeps modules whose transitive imports reach @warlock.js/web (or Vite-only source) in Vite, so the page sees ONE web", async () => {
    const shared = (name: string) => appFile("shared", name);
    fs.mkdirSync(path.dirname(shared("x")), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "web"), { recursive: true });
    fs.writeFileSync(
      shared("web-user.ts"),
      [
        `import { PublicPageError, shared } from "@warlock.js/web";`,
        `export { PublicPageError, shared };`,
        `export function failPublic() { throw new PublicPageError("visible to the visitor"); }`,
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      shared("via-web-user.ts"),
      `import { failPublic } from "./web-user";
export const run = () => failPublic();`,
      "utf8",
    );
    fs.writeFileSync(
      shared("via-alias.ts"),
      `import { run } from "app/shared/via-web-user";
export { run };`,
      "utf8",
    );
    fs.writeFileSync(shared("dep-css.ts"), `import "./dep.css";
export const a = 1;`, "utf8");
    fs.writeFileSync(shared("dep.css"), `a{color:red}`, "utf8");
    fs.writeFileSync(
      shared("via-css.ts"),
      `import { a } from "./dep-css";
export const b = a;`,
      "utf8",
    );
    writeApp(shared("clean-leaf.ts"), 1);
    fs.writeFileSync(
      shared("clean-importer.ts"),
      `import { als } from "./clean-leaf";
export { als };`,
      "utf8",
    );
    const probeFile = path.join(root, "src", "web", "probe-web.ts");
    fs.writeFileSync(
      probeFile,
      [
        `export { run } from "app/shared/via-alias";`,
        `export { PublicPageError as ProbeError, shared as probeShared } from "app/shared/web-user";`,
        `export { b } from "app/shared/via-css";`,
        `export { als } from "app/shared/clean-importer";`,
      ].join("\n"),
      "utf8",
    );

    const vite = await createViteServer(
      [coreAppModules({ appSrcRoot: path.join(root, "src"), registry, nativeImport })],
      [{ find: /^@warlock\.js\/web$/, replacement: path.join(WEB_ROOT, "src", "index.ts") }],
    );

    try {
      const bridged = async (file: string) =>
        (await vite.environments.ssr.transformRequest(file))?.code.includes("data:text/javascript");

      // The direct importer, and every module that reaches it through a relative
      // or an `app/` alias import, stays in Vite...
      for (const name of ["web-user.ts", "via-web-user.ts", "via-alias.ts"]) {
        expect(await bridged(shared(name)), name).toBe(false);
      }
      // ...so does a module that only reaches Vite-only source through a dependency...
      expect(await bridged(shared("dep-css.ts"))).toBe(false);
      expect(await bridged(shared("via-css.ts"))).toBe(false);
      // ...while an unrelated module, and its clean importer, are still bridged.
      expect(await bridged(shared("clean-leaf.ts"))).toBe(true);
      expect(await bridged(shared("clean-importer.ts"))).toBe(true);

      // The page-side behaviour the pipeline depends on. The pipeline's own web
      // copy is the one Vite evaluates; the app module must have used THAT one.
      const pipelineWeb = (await vite.ssrLoadModule(path.join(WEB_ROOT, "src", "index.ts"))) as {
        PublicPageError: new (message: string) => Error;
        shared: unknown;
      };
      const isVisitorSafe = (
        (await vite.ssrLoadModule(
          path.join(WEB_ROOT, "src", "server", "is-visitor-safe-page-error.ts"),
        )) as { isVisitorSafePageError(thrown: unknown): boolean }
      ).isVisitorSafePageError;
      const probe = (await vite.ssrLoadModule(probeFile)) as {
        run(): never;
        ProbeError: unknown;
        probeShared: unknown;
        b: number;
        als: unknown;
      };

      expect(probe.ProbeError).toBe(pipelineWeb.PublicPageError);
      expect(probe.probeShared).toBe(pipelineWeb.shared);

      let thrown: unknown;
      try {
        probe.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(pipelineWeb.PublicPageError);
      expect(isVisitorSafe(thrown)).toBe(true);
      expect(probe.b).toBe(1);

      // The bridged part is still the instance core's loader holds.
      const native = await nativeImport(pathToFileURL(shared("clean-leaf.ts")).href);
      expect(probe.als).toBe(native.als);
    } finally {
      await vite.close();
    }
  }, 120_000);

  it("is dev SSR only and inert without core's carrier", async () => {
    const plugin = coreAppModules({ appSrcRoot: path.join(root, "src") });
    expect(plugin.enforce).toBe("pre");
    expect(plugin.applyToEnvironment?.({ config: { consumer: "client" } } as never)).toBe(false);
    expect(plugin.applyToEnvironment?.({ config: { consumer: "server" } } as never)).toBe(true);

    const load = plugin.load;
    if (typeof load !== "function") throw new Error("Expected a load function");
    const file = appFile("shared", "als.ts");
    expect(await load.call({} as never, file, { ssr: true })).toBeNull();
    expect(
      await (
        coreAppModules({ appSrcRoot: path.join(root, "src"), registry }).load as Function
      ).call({} as never, file, { ssr: false }),
    ).toBeNull();
  });

  it("recognises source that only Vite can evaluate", () => {
    expect(requiresViteToEvaluate(`const a = import.meta.env.MODE;`)).toBe(true);
    expect(requiresViteToEvaluate(`const a = import.meta.glob("./*.ts");`)).toBe(true);
    expect(requiresViteToEvaluate(`import "./theme.css";`)).toBe(true);
    expect(requiresViteToEvaluate(`import logo from "./logo.svg?url";`)).toBe(true);
    expect(requiresViteToEvaluate(`import data from "./data.json";`)).toBe(true);
    expect(requiresViteToEvaluate(`import { a } from "./helper";\nexport { a };`)).toBe(false);
    expect(requiresViteToEvaluate(`export const url = import.meta.url;`)).toBe(false);
  });
});
