import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import type { ClientPageEntry, ClientRouteComposition } from "../client/runtime/types";
import { validateClientRouteManifest } from "../client/runtime/manifest";
import type { DiscoveredPage } from "./discover-pages";
import {
  CLIENT_REGISTRY_EXPORT_NAME,
  DuplicateClientPageNameError,
  generateClientRegistry,
} from "./generate-client-registry";

/**
 * The emitted module is EXECUTED, not grepped: a generator test that only
 * string-matches its own output proves the generator agrees with itself and
 * nothing more. Every specifier the generator emits is a `data:` URL stub
 * module, so `import()` inside the emitted source resolves for real — which
 * makes a syntax error a failed test rather than a bundle-time surprise
 * somebody else discovers.
 */
function toDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, "utf-8").toString("base64")}`;
}

/** An identity-ish mapper: the specifier is a module that reports its own source file. */
function stubSpecifier(absoluteFilePath: string): string {
  return toDataUrl(`export const sourceFile = ${JSON.stringify(absoluteFilePath)};`);
}

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier);
}

async function evaluate(contents: string): Promise<readonly ClientPageEntry[]> {
  const { code } = await transform(contents, { loader: "ts", format: "esm" });
  const namespace = await importModule(toDataUrl(code));

  return validateClientRouteManifest(namespace[CLIENT_REGISTRY_EXPORT_NAME]);
}

function sourceFilesOf(composition: ClientRouteComposition) {
  return {
    Page: composition.Page.sourceFile,
    layouts: composition.layouts.map((layout) => layout.sourceFile),
    ...(Object.prototype.hasOwnProperty.call(composition, "App")
      ? { App: composition.App?.sourceFile }
      : {}),
  };
}

function aPage(overrides: Partial<DiscoveredPage> = {}): DiscoveredPage {
  return {
    routeName: "main.home",
    routePath: "/",
    pageFile: "C:/app/src/app/main/web/home.page.tsx",
    webRoot: "C:/app/src/app/main/web",
    layouts: [],
    middlewareLayouts: [],
    ...overrides,
  };
}

const generate = (pages: readonly DiscoveredPage[]) =>
  generateClientRegistry({ pages, toImportSpecifier: stubSpecifier });

describe("generateClientRegistry", () => {
  it("emits a page with one layout, carrying discovery's name and path verbatim", async () => {
    const contents = generate([
      aPage({
        routeName: "products.list",
        routePath: "/products",
        pageFile: "C:/app/src/app/products/web/products.page.tsx",
        layouts: ["C:/app/src/app/products/web/layout.tsx"],
      }),
    ]);

    const [entry] = await evaluate(contents);

    expect(entry.type).toBe("page");
    expect(entry.name).toBe("products.list");
    expect(entry.path).toBe("/products");
    expect(sourceFilesOf(await entry.load())).toEqual({
      Page: "C:/app/src/app/products/web/products.page.tsx",
      layouts: ["C:/app/src/app/products/web/layout.tsx"],
    });
  });

  it("emits an empty layout chain for a page with no layouts", async () => {
    const [entry] = await evaluate(generate([aPage({ layouts: [] })]));
    const composition = await entry.load();

    expect(composition.layouts).toEqual([]);
    expect(composition.Page.sourceFile).toBe("C:/app/src/app/main/web/home.page.tsx");
  });

  it("includes App only when the page has an appFile", async () => {
    const withApp = await evaluate(
      generate([aPage({ appFile: "C:/app/src/web/root.tsx" })]),
    );
    const withoutApp = await evaluate(generate([aPage()]));

    const composedWithApp = await withApp[0].load();
    const composedWithoutApp = await withoutApp[0].load();

    expect(composedWithApp.App?.sourceFile).toBe("C:/app/src/web/root.tsx");
    // Own key ABSENT, not `App: undefined` — the runtime validator rejects an
    // `App` key whose value is not a module namespace.
    expect(Object.prototype.hasOwnProperty.call(composedWithoutApp, "App")).toBe(false);
  });

  it("keeps `load` re-invocable: a second call yields an equivalent composition", async () => {
    const [entry] = await evaluate(
      generate([
        aPage({
          layouts: ["C:/app/src/app/main/web/layout.tsx"],
          appFile: "C:/app/src/web/root.tsx",
        }),
      ]),
    );

    const first = await entry.load();
    const second = await entry.load();

    expect(sourceFilesOf(second)).toEqual(sourceFilesOf(first));
    // The bundler/loader module cache is what makes memoisation unnecessary —
    // and memoisation is what would make the second call return undefined.
    expect(second.Page).toBe(first.Page);
    expect(second.layouts[0]).toBe(first.layouts[0]);
  });

  it("preserves the layout chain order, outermost first", async () => {
    const [entry] = await evaluate(
      generate([
        aPage({
          pageFile: "C:/app/src/app/users/web/account/settings.page.tsx",
          layouts: [
            "C:/app/src/app/users/web/layout.tsx",
            "C:/app/src/app/users/web/account/layout.tsx",
          ],
        }),
      ]),
    );

    expect((await entry.load()).layouts.map((layout) => layout.sourceFile)).toEqual([
      "C:/app/src/app/users/web/layout.tsx",
      "C:/app/src/app/users/web/account/layout.tsx",
    ]);
  });

  it("preserves the order discovery gave, entry for entry", async () => {
    const entries = await evaluate(
      generate([
        aPage({ routeName: "b", routePath: "/b", pageFile: "C:/app/src/web/b.page.tsx" }),
        aPage({ routeName: "a", routePath: "/a", pageFile: "C:/app/src/web/a.page.tsx" }),
      ]),
    );

    expect(entries.map((entry) => entry.name)).toEqual(["b", "a"]);
  });

  it("throws a named error naming BOTH pages when two claim one route name", () => {
    const duplicate = () =>
      generate([
        aPage({ routeName: "main.home", pageFile: "C:/app/src/web/home.page.tsx" }),
        aPage({ routeName: "main.home", pageFile: "C:/app/src/web/index.page.tsx" }),
      ]);

    expect(duplicate).toThrow(DuplicateClientPageNameError);
    expect(duplicate).toThrow(/C:\/app\/src\/web\/home\.page\.tsx/);
    expect(duplicate).toThrow(/C:\/app\/src\/web\/index\.page\.tsx/);
    expect(duplicate).toThrow(/rename/i);
  });

  it("survives Windows backslashes and quotes in every emitted literal", async () => {
    const pageFile = 'D:\\app\\src\\web\\odd "name"\\home.page.tsx';
    const contents = generateClientRegistry({
      pages: [
        aPage({
          routeName: 'odd "name".home',
          routePath: '/odd "name"\\home',
          pageFile,
          layouts: ['D:\\app\\src\\web\\odd "name"\\layout.tsx'],
        }),
      ],
      toImportSpecifier: stubSpecifier,
    });

    const [entry] = await evaluate(contents);

    expect(entry.name).toBe('odd "name".home');
    expect(entry.path).toBe('/odd "name"\\home');
    expect((await entry.load()).Page.sourceFile).toBe(pageFile);
  });

  it("emits exactly the four contract keys per entry and nothing else", async () => {
    const [entry] = await evaluate(
      generate([aPage({ appFile: "C:/app/src/web/root.tsx", layouts: ["C:/app/l.tsx"] })]),
    );

    expect(Reflect.ownKeys(entry)).toEqual(["type", "name", "path", "load"]);
    expect(Reflect.ownKeys(await entry.load())).toEqual(["Page", "layouts", "App"]);
  });

  it("emits dynamic imports only — never a static import of a page", () => {
    const contents = generate([
      aPage({ layouts: ["C:/app/l.tsx"], appFile: "C:/app/src/web/root.tsx" }),
    ]);

    // The one static import the module is allowed is the type-only one, which
    // ships no code. Anything else would put every page in every download.
    // A STATIC import is `import` followed by anything but `(` — the dynamic
    // form is the only one allowed to name a page, a layout or the app root.
    for (const line of contents.split("\n")) {
      if (/^\s*import\s*[^(\s]/.test(line) || /^\s*import\s+/.test(line)) {
        expect(line).toMatch(/^import type /);
      }
    }

    expect(contents).toContain("import(");
  });

  it("emits a do-not-edit header with no reference that resolves outside this repo", async () => {
    const contents = generate([aPage()]);

    expect(contents.startsWith("//")).toBe(true);
    expect(contents.toLowerCase()).toMatch(/do not edit/);
    expect(contents.toLowerCase()).not.toMatch(/bureau|worker|room|@[a-z]+ said/);
    await expect(evaluate(contents)).resolves.toHaveLength(1);
  });

  it("emits a valid, empty registry for zero pages", async () => {
    expect(await evaluate(generate([]))).toEqual([]);
  });
});
