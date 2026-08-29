import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  devHandlerStylesheetUrls,
  devStylesheetUrls,
  productionStylesheetUrls,
  VITE_DIRECT_CSS_QUERY,
} from "./stylesheet-urls";

const temporaryDirectories: string[] = [];

/** Materialises a fixture tree: `{ "src/web/root.tsx": "..." }` under a temp root. */
function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-stylesheet-urls-"));
  temporaryDirectories.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return root;
}

/** Writes `<root>/.vite/manifest.json` under a fresh client dir and returns the client dir. */
function makeClientDir(manifest: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-stylesheet-urls-client-"));
  temporaryDirectories.push(root);

  const viteDir = path.join(root, ".vite");
  fs.mkdirSync(viteDir, { recursive: true });
  fs.writeFileSync(path.join(viteDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("devStylesheetUrls — one file's own imports", () => {
  it("maps a directly imported stylesheet to a ?direct URL relative to appRoot", () => {
    const appRoot = makeTree({
      "src/web/root.tsx": 'import "./app.css";\nexport default function Root() {}\n',
      "src/web/app.css": "",
    });

    expect(devStylesheetUrls(appRoot, path.join(appRoot, "src/web/root.tsx"))).toEqual([
      `/src/web/app.css${VITE_DIRECT_CSS_QUERY}`,
    ]);
  });

  it("ignores non-stylesheet imports and dedupes a stylesheet imported twice", () => {
    const appRoot = makeTree({
      "src/web/page.page.tsx":
        'import "./one.css";\nimport "react";\nimport "./one.css";\nexport default function Page() {}\n',
      "src/web/one.css": "",
    });

    expect(devStylesheetUrls(appRoot, path.join(appRoot, "src/web/page.page.tsx"))).toEqual([
      `/src/web/one.css${VITE_DIRECT_CSS_QUERY}`,
    ]);
  });

  it("drops a stylesheet outside appRoot rather than emitting an /@fs/ URL", () => {
    const appRoot = makeTree({ "src/web/root.tsx": 'import "../../../outside.css";\n' });

    expect(devStylesheetUrls(appRoot, path.join(appRoot, "src/web/root.tsx"))).toEqual([]);
  });

  it("returns nothing for a file it cannot read, rather than throwing", () => {
    const appRoot = makeTree({});

    expect(devStylesheetUrls(appRoot, path.join(appRoot, "src/web/missing.page.tsx"))).toEqual(
      [],
    );
  });
});

describe("devHandlerStylesheetUrls — one handler's whole chain", () => {
  it("concatenates root, layout, and page in that order", () => {
    const appRoot = makeTree({
      "src/web/root.tsx": 'import "./root.css";\n',
      "src/web/root.css": "",
      "src/app/main/web/layout.tsx": 'import "./layout.css";\n',
      "src/app/main/web/layout.css": "",
      "src/app/main/web/home.page.tsx": 'import "./home.css";\n',
      "src/app/main/web/home.css": "",
    });

    const urls = devHandlerStylesheetUrls(appRoot, [
      path.join(appRoot, "src/web/root.tsx"),
      path.join(appRoot, "src/app/main/web/layout.tsx"),
      path.join(appRoot, "src/app/main/web/home.page.tsx"),
    ]);

    expect(urls).toEqual([
      `/src/web/root.css${VITE_DIRECT_CSS_QUERY}`,
      `/src/app/main/web/layout.css${VITE_DIRECT_CSS_QUERY}`,
      `/src/app/main/web/home.css${VITE_DIRECT_CSS_QUERY}`,
    ]);
  });

  it("dedupes a stylesheet shared across chain members, keeping its first position", () => {
    const appRoot = makeTree({
      "src/web/root.tsx": 'import "./shared.css";\n',
      "src/web/shared.css": "",
      "src/app/main/web/home.page.tsx": 'import "../../../web/shared.css";\nimport "./own.css";\n',
      "src/app/main/web/own.css": "",
    });

    const urls = devHandlerStylesheetUrls(appRoot, [
      path.join(appRoot, "src/web/root.tsx"),
      path.join(appRoot, "src/app/main/web/home.page.tsx"),
    ]);

    expect(urls).toEqual([
      `/src/web/shared.css${VITE_DIRECT_CSS_QUERY}`,
      `/src/app/main/web/own.css${VITE_DIRECT_CSS_QUERY}`,
    ]);
  });

  it("carries multiple matched layouts outer to inner, between root and page", () => {
    const appRoot = makeTree({
      "src/web/root.tsx": "",
      "src/app/users/web/layout.tsx": 'import "./outer.css";\n',
      "src/app/users/web/outer.css": "",
      "src/app/users/web/account/layout.tsx": 'import "./inner.css";\n',
      "src/app/users/web/account/inner.css": "",
      "src/app/users/web/account/settings.page.tsx": "",
    });

    const urls = devHandlerStylesheetUrls(appRoot, [
      path.join(appRoot, "src/web/root.tsx"),
      path.join(appRoot, "src/app/users/web/layout.tsx"),
      path.join(appRoot, "src/app/users/web/account/layout.tsx"),
      path.join(appRoot, "src/app/users/web/account/settings.page.tsx"),
    ]);

    expect(urls).toEqual([
      `/src/app/users/web/outer.css${VITE_DIRECT_CSS_QUERY}`,
      `/src/app/users/web/account/inner.css${VITE_DIRECT_CSS_QUERY}`,
    ]);
  });
});

describe("productionStylesheetUrls — matching explicit source ids", () => {
  it("matches a manifest key that equals the source id exactly", () => {
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root-abc.js", css: ["assets/root-abc.css"] },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([
      "/assets/root-abc.css",
    ]);
  });

  it("matches a manifest key that carries the source id as a /-boundary suffix", () => {
    const clientDir = makeClientDir({
      "../my-app/src/web/root.tsx": { file: "assets/root-abc.js", css: ["assets/root-abc.css"] },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([
      "/assets/root-abc.css",
    ]);
  });

  it("does not match a source id that is merely a partial-segment suffix of a key", () => {
    const clientDir = makeClientDir({
      "src/web/other-root.tsx": { file: "assets/other-abc.js", css: ["assets/other-abc.css"] },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([]);
  });

  it("contributes nothing for a source id with no manifest entry, rather than throwing", () => {
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root-abc.js", css: ["assets/root-abc.css"] },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/missing.page.tsx"])).toEqual([]);
  });
});

describe("productionStylesheetUrls — recursive chunk collection", () => {
  it("recursively collects css from statically imported chunks", () => {
    const clientDir = makeClientDir({
      "src/app/main/web/home.page.tsx": {
        file: "assets/home.page-abc.js",
        css: ["assets/home.page-abc.css"],
        imports: ["_link-abc.js"],
      },
      "_link-abc.js": {
        file: "assets/link-abc.js",
        css: ["assets/link-abc.css"],
        imports: ["_http-abc.js"],
      },
      "_http-abc.js": {
        file: "assets/http-abc.js",
        css: ["assets/http-abc.css"],
      },
    });

    expect(productionStylesheetUrls(clientDir, ["src/app/main/web/home.page.tsx"])).toEqual([
      "/assets/home.page-abc.css",
      "/assets/link-abc.css",
      "/assets/http-abc.css",
    ]);
  });

  it("guards against a chunk import cycle instead of recursing forever", () => {
    const clientDir = makeClientDir({
      "src/web/root.tsx": {
        file: "assets/root-abc.js",
        css: ["assets/root-abc.css"],
        imports: ["_a-abc.js"],
      },
      "_a-abc.js": { file: "assets/a-abc.js", css: ["assets/a-abc.css"], imports: ["_b-abc.js"] },
      "_b-abc.js": { file: "assets/b-abc.js", css: ["assets/b-abc.css"], imports: ["_a-abc.js"] },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([
      "/assets/root-abc.css",
      "/assets/a-abc.css",
      "/assets/b-abc.css",
    ]);
  });

  it("never follows dynamicImports, so an unrelated page's CSS never leaks onto this handler", () => {
    const clientDir = makeClientDir({
      "src/hydration/index.ts": {
        file: "assets/hydration-abc.js",
        isEntry: true,
        dynamicImports: ["src/app/other/web/other.page.tsx"],
      },
      "src/app/other/web/other.page.tsx": {
        file: "assets/other.page-abc.js",
        css: ["assets/other.page-abc.css"],
      },
      "src/web/root.tsx": {
        file: "assets/root-abc.js",
        css: ["assets/root-abc.css"],
        imports: ["src/hydration/index.ts"],
      },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([
      "/assets/root-abc.css",
    ]);
  });
});

describe("productionStylesheetUrls — the handler's whole ordered, deduped chain", () => {
  it("orders root, then outer-to-inner layouts, then the page, and dedupes across all four", () => {
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root-abc.js", css: ["assets/shared-abc.css"] },
      "src/app/users/web/layout.tsx": {
        file: "assets/outer-layout-abc.js",
        css: ["assets/outer-layout-abc.css"],
      },
      "src/app/users/web/account/layout.tsx": {
        file: "assets/inner-layout-abc.js",
        css: ["assets/shared-abc.css", "assets/inner-layout-abc.css"],
      },
      "src/app/users/web/account/settings.page.tsx": {
        file: "assets/settings.page-abc.js",
        css: ["assets/settings.page-abc.css"],
      },
    });

    const urls = productionStylesheetUrls(clientDir, [
      "src/web/root.tsx",
      "src/app/users/web/layout.tsx",
      "src/app/users/web/account/layout.tsx",
      "src/app/users/web/account/settings.page.tsx",
    ]);

    expect(urls).toEqual([
      "/assets/shared-abc.css",
      "/assets/outer-layout-abc.css",
      "/assets/inner-layout-abc.css",
      "/assets/settings.page-abc.css",
    ]);
  });
});

describe("productionStylesheetUrls — failure and boundary conditions", () => {
  it("returns nothing when the manifest file is missing", () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-stylesheet-urls-empty-"));
    temporaryDirectories.push(clientDir);

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([]);
  });

  it("returns nothing when the manifest is not valid JSON", () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-stylesheet-urls-bad-"));
    temporaryDirectories.push(clientDir);
    fs.mkdirSync(path.join(clientDir, ".vite"), { recursive: true });
    fs.writeFileSync(path.join(clientDir, ".vite", "manifest.json"), "not json", "utf-8");

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([]);
  });

  it("drops a css file the manifest names outside the served asset prefix", () => {
    const clientDir = makeClientDir({
      "src/web/root.tsx": { file: "assets/root-abc.js", css: ["public/root-abc.css"] },
    });

    expect(productionStylesheetUrls(clientDir, ["src/web/root.tsx"])).toEqual([]);
  });
});
