import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverPageGraph,
  discoverPageFileGraph,
  discoverPageFiles,
  discoverPages,
  isDiscoveredRoutablePage,
} from "./discover-pages";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-discover-page-graph-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const sourceFile = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, contents, "utf-8");
  }

  return appRoot;
}

function page(route: string): string {
  return `export const config = { route: ${JSON.stringify(route)} };\nexport default function Page() { return null; }\n`;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("discoverPageGraph", () => {
  it("returns the same pages as discoverPages and finds root, nested, group, dynamic, and orphan locale files", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": "export default function Root() { return null; }\n",
      "src/web/index.page.tsx": page("/"),
      "src/web/locales.json": "{}\n",
      "src/web/products/item.page.tsx": page("/products/item"),
      "src/web/products/locales.json": "{}\n",
      "src/web/products/[id].page.tsx": page("/products/:id"),
      "src/web/(marketing)/about.page.tsx": page("/about"),
      "src/web/(marketing)/locales.json": "{}\n",
      "src/web/orphan/locales.json": "{}\n",
    });

    const graph = discoverPageGraph({ appRoot });

    expect(graph.pages).toEqual(discoverPages({ appRoot }));
    expect(graph.pages.filter(isDiscoveredRoutablePage).map((entry) => entry.routePath)).toEqual([
      "/about",
      "/",
      "/products/:id",
      "/products/item",
    ]);
    expect(
      graph.localeFiles.map(({ sourceFile }) =>
        path.relative(appRoot, sourceFile).replaceAll("\\", "/"),
      ),
    ).toEqual([
      "src/web/(marketing)/locales.json",
      "src/web/locales.json",
      "src/web/orphan/locales.json",
      "src/web/products/locales.json",
    ]);
    expect(
      graph.localeFiles.every(({ webRoot }) => webRoot === path.join(appRoot, "src/web")),
    ).toBe(true);
  });

  it("returns no locale files when the page tree has no locales.json", () => {
    const appRoot = makeAppTree({ "src/web/home.page.tsx": page("/home") });

    const graph = discoverPageGraph({ appRoot });

    expect(graph.pages).toEqual(discoverPages({ appRoot }));
    expect(graph.localeFiles).toEqual([]);
  });

  it("keeps source-only discovery tolerant of malformed page source while the static graph validates it", () => {
    const appRoot = makeAppTree({
      "src/web/broken.page.tsx": "export const config = ;\n",
    });
    const srcRoot = path.join(appRoot, "src");

    const sourceGraph = discoverPageFileGraph(srcRoot);

    expect(sourceGraph.pages).toEqual(discoverPageFiles(srcRoot));
    expect(sourceGraph.pages.map(({ pageFile }) => path.basename(pageFile))).toEqual([
      "broken.page.tsx",
    ]);
    expect(sourceGraph.localeFiles).toEqual([]);
    expect(() => discoverPageGraph({ appRoot })).toThrow(/Cannot inspect the default export/);
  });
});
