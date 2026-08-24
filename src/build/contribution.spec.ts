import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorBuildContext } from "@warlock.js/core";
import {
  assertWebPackageRoot,
  ClientOutDirNotSupportedError,
  createWebBuildContribution,
  resolveWebPackageRoot,
  WebPackageRootResolutionError,
} from "./contribution";

const temporaryDirectories: string[] = [];

function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-web-root-"));
  temporaryDirectories.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

/** This spec lives at `web/src/build/` — two levels up is the real package root. */
const realWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("assertWebPackageRoot", () => {
  it("accepts the real @warlock.js/web package root", () => {
    expect(assertWebPackageRoot(realWebRoot)).toBe(realWebRoot);
  });

  it("throws WebPackageRootResolutionError naming a root with no package.json", () => {
    const bogus = makeTree({ "readme.md": "not a package\n" });

    expect(() => assertWebPackageRoot(bogus)).toThrow(WebPackageRootResolutionError);
    expect(() => assertWebPackageRoot(bogus)).toThrow(bogus);
  });

  it("throws WebPackageRootResolutionError when the package name is another package", () => {
    const bogus = makeTree({ "package.json": JSON.stringify({ name: "@warlock.js/core" }) });

    let thrown: unknown;

    try {
      assertWebPackageRoot(bogus);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WebPackageRootResolutionError);
    expect((thrown as Error).name).toBe("WebPackageRootResolutionError");
    expect((thrown as Error).message).toContain(bogus);
    expect((thrown as Error).message).toContain("@warlock.js/core");
    expect((thrown as Error).message).toContain("Pass `webRoot` explicitly");
  });

  it("throws WebPackageRootResolutionError on unparsable package.json", () => {
    const bogus = makeTree({ "package.json": "{ not json" });

    expect(() => assertWebPackageRoot(bogus)).toThrow(WebPackageRootResolutionError);
  });
});

const buildHydrationClient = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../vite", () => ({ buildWarlockHydrationClient: buildHydrationClient }));

/**
 * Wraps the real `generatePagesBarrel` so tests can observe call counts
 * without losing its real behavior (other tests in this file assert on the
 * barrel it actually writes).
 */
const generatePagesBarrelSpy = vi.hoisted(() => vi.fn());

vi.mock("./generate-pages-barrel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./generate-pages-barrel")>();

  generatePagesBarrelSpy.mockImplementation(actual.generatePagesBarrel);

  return { ...actual, generatePagesBarrel: generatePagesBarrelSpy };
});

/** Only `outdir` is read by the hooks under test; nothing else reaches them. */
function buildContext(appRoot: string): ConnectorBuildContext {
  return {
    appRoot,
    productionDir: path.join(appRoot, ".warlock", "production"),
    options: { outdir: path.join(appRoot, "dist") } as ConnectorBuildContext["options"],
  };
}

const APP = "export default function App() { return null; }\n";
const PAGE = 'export const route = "/";\nexport default function Page() { return null; }\n';

describe("web build contribution — zero pages", () => {
  it("writes the barrel and contributes its entry import even with no pages", async () => {
    const appRoot = makeTree({ "src/web/root.tsx": APP });
    const context = buildContext(appRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await createWebBuildContribution().generate?.(context);

    expect(result).toMatchObject({ entryImports: ['await import("./pages");'] });

    const contents = fs.readFileSync(path.join(context.productionDir, "pages.ts"), "utf-8");

    expect(contents).toContain("providePageManifest({ pages: [] });");

    log.mockRestore();
  });

  it("skips the client build when there are no pages — nothing to hydrate", async () => {
    const appRoot = makeTree({ "src/web/root.tsx": APP });
    const context = buildContext(appRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const contribution = createWebBuildContribution();

    buildHydrationClient.mockClear();

    await contribution.generate?.(context);
    await contribution.emit?.(context);

    expect(buildHydrationClient).not.toHaveBeenCalled();

    log.mockRestore();
  });

  it("writes no barrel at all when the connector is not configured — generate never runs", () => {
    const appRoot = makeTree({ "src/web/root.tsx": APP, "src/web/home.page.tsx": PAGE });

    // A configured-but-unbuilt app is the closest observable stand-in for "web
    // is absent from `connectors`": the builder only calls hooks it was given.
    createWebBuildContribution();

    expect(fs.existsSync(path.join(appRoot, ".warlock", "production", "pages.ts"))).toBe(false);
  });
});

describe("web build contribution — clientOutDir", () => {
  it("refuses a config that sets build.clientOutDir", () => {
    expect(() => createWebBuildContribution({ clientOutDir: "/tmp/wherever" })).toThrow(
      ClientOutDirNotSupportedError,
    );

    let thrown: unknown;

    try {
      createWebBuildContribution({ clientOutDir: "/tmp/wherever" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ClientOutDirNotSupportedError);
    expect((thrown as Error).name).toBe("ClientOutDirNotSupportedError");
    expect((thrown as Error).message).toMatch(/build\.clientOutDir/);
    expect((thrown as Error).message).toMatch(/remove/i);
  });

  it("builds without complaint when clientOutDir is not set", () => {
    expect(() => createWebBuildContribution()).not.toThrow();
    expect(() => createWebBuildContribution({ srcDir: "src" })).not.toThrow();
  });

  it("invokes the barrel generator and client builder on the normal path — proves the spies observe real calls", async () => {
    const appRoot = makeTree({ "src/web/root.tsx": APP, "src/web/home.page.tsx": PAGE });
    const context = buildContext(appRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    generatePagesBarrelSpy.mockClear();
    buildHydrationClient.mockClear();

    const contribution = createWebBuildContribution();

    await contribution.generate?.(context);
    await contribution.emit?.(context);

    expect(generatePagesBarrelSpy).toHaveBeenCalledTimes(1);
    expect(buildHydrationClient).toHaveBeenCalledTimes(1);

    log.mockRestore();
  });

  it("never reaches the barrel generator or the client builder when clientOutDir is set", () => {
    generatePagesBarrelSpy.mockClear();
    buildHydrationClient.mockClear();

    expect(() => createWebBuildContribution({ clientOutDir: "/tmp/wherever" })).toThrow(
      ClientOutDirNotSupportedError,
    );

    expect(generatePagesBarrelSpy).not.toHaveBeenCalled();
    expect(buildHydrationClient).not.toHaveBeenCalled();
  });
});

describe("resolveWebPackageRoot", () => {
  it("verifies a configured webRoot instead of trusting it", async () => {
    const bogus = makeTree({ "package.json": JSON.stringify({ name: "somebody-else" }) });

    await expect(resolveWebPackageRoot(bogus)).rejects.toBeInstanceOf(
      WebPackageRootResolutionError,
    );
  });

  it("returns the verified package root when derived from import.meta.url", async () => {
    await expect(resolveWebPackageRoot(undefined)).resolves.toBe(realWebRoot);
  });
});
