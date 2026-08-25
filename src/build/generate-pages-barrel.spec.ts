import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generatePagesBarrel,
  layoutChainFor,
  NestedLayoutsNotSupportedError,
  WebPageGraphUnsupportedImportError,
  WEB_ENTRY_IMPORT,
  WEB_ESBUILD_PATCH,
} from "./generate-pages-barrel";

const temporaryDirectories: string[] = [];

/** Materialises a fixture app tree: `{ "src/web/root.tsx": "…" }` under a temp root. */
function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-app-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

const APP = 'export default function App() { return null; }\n';
const PAGE = 'export const route = "/";\nexport default function Page() { return null; }\n';
const LAYOUT = 'export default function Layout() { return null; }\n';

describe("generatePagesBarrel", () => {
  it("writes named namespace imports and a route-free manifest call", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/layout.tsx": LAYOUT,
      "src/app/main/web/home.page.tsx": PAGE,
    });
    const productionDir = path.join(appRoot, ".warlock", "production");

    const result = await generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" });

    expect(result.pageCount).toBe(1);
    expect(result.barrelFile).toBe(path.join(productionDir, "pages.ts"));

    const contents = fs.readFileSync(result.barrelFile as string, "utf-8");

    expect(contents).toContain(
      'import { providePageManifest } from "@warlock.js/web/connector";',
    );
    expect(contents).toContain('import * as app from "../../src/web/root";');
    expect(contents).toContain('import * as l0 from "../../src/app/main/web/layout";');
    expect(contents).toContain('import * as p0 from "../../src/app/main/web/home.page";');
    expect(contents).toContain('app: { module: app, sourceFile: "src/web/root.tsx" }');
    expect(contents).toContain('sourceFile: "src/app/main/web/home.page.tsx"');
    expect(contents).toContain(
      'layouts: [{ module: l0, sourceFile: "src/app/main/web/layout.tsx" }]',
    );
    // No route paths in the table — they are read off the modules at boot.
    expect(contents).not.toContain("path:");
  });

  it("collects pages from BOTH web roots when each page has at most one layout", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/layout.tsx": LAYOUT,
      "src/web/dashboard.page.tsx": PAGE,
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": PAGE,
    });
    const productionDir = path.join(appRoot, ".warlock", "production");

    const result = await generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" });
    const contents = result.contents as string;

    expect(result.pageCount).toBe(2);
    expect(contents).toContain('sourceFile: "src/web/dashboard.page.tsx"');
    expect(contents).toContain('sourceFile: "src/app/users/web/account/settings.page.tsx"');

    const nested = contents
      .split("\n")
      .find((line) => line.includes("layouts:") && line.includes("account/layout.tsx"));

    expect(nested).toBeDefined();
    expect(nested as string).toMatch(
      /layouts: \[\{ module: \w+, sourceFile: "src\/app\/users\/web\/account\/layout\.tsx" \}\]/,
    );
  });

  it("refuses to emit a page whose layout chain has more than one layout, naming the page and every layout", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/users/web/layout.tsx": LAYOUT,
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": PAGE,
    });
    const productionDir = path.join(appRoot, ".warlock", "production");

    await expect(generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" })).rejects.toThrowError(
      NestedLayoutsNotSupportedError,
    );
    expect(fs.existsSync(path.join(productionDir, "pages.ts"))).toBe(false);
  });

  it("layoutChainFor walks web root -> page dir, outermost first", () => {
    const appRoot = makeAppTree({
      "src/app/users/web/layout.tsx": LAYOUT,
      "src/app/users/web/account/layout.tsx": LAYOUT,
      "src/app/users/web/account/settings.page.tsx": PAGE,
    });
    const webRoot = path.join(appRoot, "src/app/users/web");

    expect(layoutChainFor(path.join(webRoot, "account/settings.page.tsx"), webRoot)).toEqual([
      path.join(webRoot, "layout.tsx"),
      path.join(webRoot, "account", "layout.tsx"),
    ]);
  });

  it("writes an EMPTY manifest barrel and says so out loud when there are zero pages", async () => {
    const appRoot = makeAppTree({ "src/web/root.tsx": APP });
    const productionDir = path.join(appRoot, ".warlock", "production");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" });

    expect(result.pageCount).toBe(0);
    expect(log).toHaveBeenCalledWith("web configured, 0 pages");

    const barrelFile = path.join(productionDir, "pages.ts");

    expect(result.barrelFile).toBe(barrelFile);
    expect(fs.existsSync(barrelFile)).toBe(true);

    const contents = fs.readFileSync(barrelFile, "utf-8");

    expect(contents).toBe(result.contents);
    expect(contents).toContain(
      'import { providePageManifest } from "@warlock.js/web/connector";',
    );
    // The whole point of the empty table: the call happens, with no pages…
    expect(contents).toContain("providePageManifest({ pages: [] });");
    // …and with no app entry, since nothing renders inside it.
    expect(contents).not.toContain("import * as app");
    expect(contents).not.toContain("app:");

    log.mockRestore();
  });

  it("writes zero page imports into the empty barrel — nothing to import means nothing to break", async () => {
    const appRoot = makeAppTree({ "src/web/root.tsx": APP });
    const productionDir = path.join(appRoot, ".warlock", "production");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" });

    const importLines = (result.contents as string)
      .split("\n")
      .filter((line) => line.startsWith("import "));

    expect(importLines).toEqual([
      'import { providePageManifest } from "@warlock.js/web/connector";',
    ]);

    vi.restoreAllMocks();
  });

  it("fails when pages exist but the app root component does not", async () => {
    const appRoot = makeAppTree({ "src/app/main/web/home.page.tsx": PAGE });

    await expect(
      generatePagesBarrel({ appRoot, productionDir: path.join(appRoot, ".warlock/production"), clientDir: "dist/client" }),
    ).rejects.toThrowError(/src\/web\/root.tsx/);
  });

  it("contributes the spike-settled esbuild patch and no NODE_ENV define", () => {
    expect(WEB_ESBUILD_PATCH.jsx).toBe("automatic");
    expect(WEB_ESBUILD_PATCH.jsxImportSource).toBe("react");
    expect(WEB_ESBUILD_PATCH.define).toEqual({
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.SSR": "true",
      "import.meta.env.MODE": '"production"',
    });
    expect(Object.keys(WEB_ESBUILD_PATCH.define as Record<string, string>)).not.toContain(
      "process.env.NODE_ENV",
    );
    expect(WEB_ENTRY_IMPORT).toBe('await import("./pages");');
  });
});

describe("the Vite-switch tripwire", () => {
  // Stylesheets are deliberately absent from this list. They used to trip the
  // tripwire, which made `import "./app.css"` — the way Tailwind and every
  // other CSS pipeline is wired — fail the production build outright. The
  // esbuild `loader` map in WEB_ESBUILD_PATCH now stubs them to empty for the
  // SERVER bundle only, because the server needs a stylesheet's URL and never
  // its bytes; the client bundle still emits the real asset. The two tests
  // below pin that pass-through, so the relaxation cannot silently widen.
  const cases: [string, string, string][] = [
    ["an asset", 'import logo from "../logo.svg";\n', "../logo.svg"],
    ["a ?raw query", 'import readme from "./readme.md?raw";\n', "./readme.md?raw"],
    ["a ?url query", 'import href from "./doc.pdf?url";\n', "./doc.pdf?url"],
  ];

  for (const [label, source, specifier] of cases) {
    it(`fires on ${label}, naming the file and the specifier`, async () => {
      const appRoot = makeAppTree({
        "src/web/root.tsx": APP,
        "src/app/main/web/home.page.tsx": `${source}${PAGE}`,
      });

      try {
        await generatePagesBarrel({
          appRoot,
          productionDir: path.join(appRoot, ".warlock/production"),
          clientDir: "dist/client",
        });
        expect.unreachable("expected the tripwire to fire");
      } catch (error) {
        expect(error).toBeInstanceOf(WebPageGraphUnsupportedImportError);
        const message = (error as Error).message;
        expect(message).toContain("src/app/main/web/home.page.tsx");
        expect(message).toContain(specifier);
        // The message must stand on its own for an app author: what the build
        // cannot do, and what to change in their file.
        expect(message).toContain("Pages are compiled into the server bundle");
        expect(message).toContain("To fix: remove the import from this file");
      }
    });
  }

  it("fires on import.meta.url even without an import specifier", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/home.page.tsx": `const here = import.meta.url;\n${PAGE}`,
    });

    await expect(
      generatePagesBarrel({ appRoot, productionDir: path.join(appRoot, ".warlock/production"), clientDir: "dist/client" }),
    ).rejects.toThrowError(WebPageGraphUnsupportedImportError);
  });

  it("scans non-page sources under the web roots too, and leaves the barrel unwritten", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/components/button.tsx": 'import icon from "./button.svg";\nexport const Button = icon;\n',
      "src/app/main/web/home.page.tsx": PAGE,
    });
    const productionDir = path.join(appRoot, ".warlock/production");

    await expect(generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" })).rejects.toThrowError(
      /button\.tsx/,
    );
    expect(fs.existsSync(path.join(productionDir, "pages.ts"))).toBe(false);
  });

  it("lets an ordinary relative or package import through", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/home.page.tsx": `import { useState } from "react";\nimport { helper } from "../utils/helper";\n${PAGE}`,
      "src/app/main/utils/helper.ts": "export const helper = 1;\n",
    });

    await expect(
      generatePagesBarrel({ appRoot, productionDir: path.join(appRoot, ".warlock/production"), clientDir: "dist/client" }),
    ).resolves.toMatchObject({ pageCount: 1 });
  });

  it("lets a stylesheet import through from a page, and writes the barrel", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/home.page.tsx": `import "./home.css";\n${PAGE}`,
    });
    const productionDir = path.join(appRoot, ".warlock/production");

    await expect(
      generatePagesBarrel({ appRoot, productionDir, clientDir: "dist/client" }),
    ).resolves.toMatchObject({ pageCount: 1 });
    expect(fs.existsSync(path.join(productionDir, "pages.ts"))).toBe(true);
  });

  it("lets a stylesheet import through from a non-page source under a web root", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": `import "./app.css";\n${APP}`,
      "src/web/components/button.tsx": 'import "./button.scss";\nexport const Button = null;\n',
      "src/app/main/web/home.page.tsx": PAGE,
    });

    await expect(
      generatePagesBarrel({ appRoot, productionDir: path.join(appRoot, ".warlock/production"), clientDir: "dist/client" }),
    ).resolves.toMatchObject({ pageCount: 1 });
  });

  it("still fires on every non-stylesheet hazard reached through a stylesheet-importing file", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/app/main/web/home.page.tsx": `import "./home.css";\nimport logo from "./logo.svg";\n${PAGE}`,
    });

    await expect(
      generatePagesBarrel({ appRoot, productionDir: path.join(appRoot, ".warlock/production"), clientDir: "dist/client" }),
    ).rejects.toThrowError(WebPageGraphUnsupportedImportError);
  });
});
