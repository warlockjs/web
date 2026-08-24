/**
 * The server half of the build→runtime handoff: the generated
 * `<productionDir>/pages.ts` barrel that carries the page graph into the
 * server bundle.
 *
 * The graph itself comes from `discover-pages.ts`, the one scan every provider
 * shares — this module is the BARREL provider and nothing more. It takes the
 * recipe, runs the Vite-switch tripwire over the sources the recipe came from,
 * and writes the file.
 *
 * "Static" means the FILESYSTEM ONLY — discovery globs `*.page.tsx`,
 * `layout.tsx` and `root.tsx` and never imports a single application module,
 * mirroring how the builder already globs (`production-builder.ts:184-242`).
 * The imports happen at BOOT, when the compiled barrel runs, which is what
 * makes a page that throws on import a loud pre-listen failure in production.
 *
 * This is the HEAVY half of the contribution: `contribution.ts` reaches it by
 * dynamic import inside its `generate` hook, so nothing here lands in a
 * connector's static graph.
 */
import fs from "node:fs";
import path from "node:path";
import type { ConnectorEsbuildPatch } from "@warlock.js/core";
import { discoverPages, discoverWebRoots, isFile, toPosix, walkFiles } from "./discover-pages";

// Re-exported, not redefined: discovery's helpers were this module's before the
// split, and the callers that already reach for them here should keep getting
// the one implementation rather than a copy that can drift from it. The nested
// layout error re-exports from the layout policy module, the one place that
// owns layout selection and its error contract.
export {
  discoverPages,
  discoverWebRoots,
  DuplicatePageRouteNameError,
  layoutChainFor,
} from "./discover-pages";
export { NestedLayoutsNotSupportedError } from "../routing/layout-policy";
export type { DiscoveredPage, DiscoverPagesOptions } from "./discover-pages";

/**
 * The esbuild patch web contributes (spike-settled, contract §3a).
 *
 * NO `process.env.NODE_ENV` define: warlock assigns to `process.env.NODE_ENV`
 * at runtime (`core/src/utils/environment.ts:14`) and a define would turn that
 * assignment into an assignment to a literal.
 */
export const WEB_ESBUILD_PATCH: ConnectorEsbuildPatch = {
  jsx: "automatic",
  jsxImportSource: "react",
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.SSR": "true",
    "import.meta.env.MODE": '"production"',
  },
};

/** Line appended to section 4 of the generated production entry, after `./routes`. */
export const WEB_ENTRY_IMPORT = 'await import("./pages");';

const REMEDY =
  "remove the import from this file (move it into a client-only module, or " +
  "reference the asset by URL instead), or wait for the Vite-based server " +
  "build, which is the only build that can compile imports like this one";

const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

const ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".webm",
];

export type GeneratePagesBarrelOptions = {
  /** Absolute path to the application root (where `package.json` lives). */
  appRoot: string;
  /** Absolute path to `.warlock/production` — where the barrel is written. */
  productionDir: string;
  /** Source directory name under `appRoot`; defaults to `"src"`. */
  srcDir?: string;
  /**
   * App-root-relative POSIX path of the client bundle directory
   * (`"dist/client"`), baked into the manifest for the runtime to read back.
   * See `PageManifest.clientDir` for why it cannot be derived at boot.
   *
   * The CALLER resolves it, from the same `context.options.outdir` the client
   * build itself writes to, so the two cannot name different directories.
   */
  clientDir: string;
};

export type GeneratePagesBarrelResult = {
  /** How many `*.page.tsx` files discovery found across both web roots. */
  pageCount: number;
  /** Absolute path of the written barrel. Always written when this runs at all. */
  barrelFile: string;
  /** The written barrel source. */
  contents: string;
};

/** Raised by the Vite-switch tripwire. */
export class WebPageGraphUnsupportedImportError extends Error {
  public constructor(
    public readonly sourceFile: string,
    public readonly specifier: string,
    reason: string,
  ) {
    super(
      `Cannot build the page graph: "${sourceFile}" ${reason} (${specifier}). ` +
        "Pages are compiled into the server bundle, which supports plain code imports only — " +
        "stylesheets, static assets, `?raw`/`?url` queries and `import.meta.url` are not supported there. " +
        `To fix: ${REMEDY}.`,
    );
    this.name = "WebPageGraphUnsupportedImportError";
  }
}

const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function collectSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const pattern of [FROM_SPECIFIER, BARE_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;

    let match = pattern.exec(source);

    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }

  return specifiers;
}

function hazardFor(specifier: string): string | undefined {
  const [base, query] = specifier.split("?", 2);
  const lowered = base.toLowerCase();

  if (STYLE_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
    return "imports a stylesheet";
  }

  if (ASSET_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
    return "imports a static asset";
  }

  if (query !== undefined && /(^|&)(raw|url)(&|=|$)/.test(query)) {
    return "uses a bundler-specific import query";
  }

  return undefined;
}

/**
 * The Vite-switch tripwire. Fails the build
 * the moment the page graph needs a capability the esbuild server build does
 * not have, naming the file, the specifier and the remedy.
 *
 * LIMITATION, stated on purpose: this is a FILE-LEVEL scan of the `.ts`/`.tsx`
 * sources under the discovered web roots — it is not transitive resolution. A
 * page that imports a workspace package which itself imports CSS is not
 * caught here; that failure surfaces at esbuild time instead. Widening the
 * scan to the resolved graph is the separate `assertGeneratedImports` card.
 */
export function assertNoViteOnlyImports(webRoots: readonly string[], appRoot: string): void {
  for (const webRoot of webRoots) {
    const sources = walkFiles(
      webRoot,
      (fileName) => fileName.endsWith(".ts") || fileName.endsWith(".tsx"),
    );

    for (const sourceFile of sources) {
      const source = fs.readFileSync(sourceFile, "utf-8");
      const relative = toPosix(path.relative(appRoot, sourceFile));

      for (const specifier of collectSpecifiers(source)) {
        const reason = hazardFor(specifier);

        if (reason !== undefined) {
          throw new WebPageGraphUnsupportedImportError(relative, specifier, reason);
        }
      }

      if (source.includes("import.meta.url")) {
        throw new WebPageGraphUnsupportedImportError(
          relative,
          "import.meta.url",
          "uses `import.meta.url`, whose meaning changes under the bundled server build",
        );
      }
    }
  }
}

/** `<productionDir>` -> `<file>` as an extensionless, POSIX, relative specifier. */
function importSpecifierFor(productionDir: string, file: string): string {
  const relative = toPosix(path.relative(productionDir, file)).replace(/\.tsx?$/, "");

  return relative.startsWith(".") ? relative : `./${relative}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

interface BarrelPage {
  identifier: string;
  sourceFile: string;
  layouts: { identifier: string; sourceFile: string }[];
}

/** Header of every generated barrel — the banner plus the one runtime import. */
const BARREL_HEADER = [
  "// AUTO-GENERATED by @warlock.js/web — do not edit.",
  "// The page graph, compiled into the server bundle.",
  "// Route paths are deliberately absent: they are read off each module at boot.",
  // The CONNECTOR subpath, never the root barrel: this file is compiled into
  // the server bundle, and `"@warlock.js/web"` would drag React in with it.
  'import { providePageManifest } from "@warlock.js/web/connector";',
];

/**
 * The barrel written when discovery found no pages at all.
 *
 * No app entry: `root.tsx` is the root every PAGE renders inside, so with zero
 * pages there is nothing for it to wrap and requiring it would fail builds that
 * are legitimately page-free.
 */
const EMPTY_BARREL_CONTENTS = [
  ...BARREL_HEADER,
  "",
  "// Zero pages were discovered. The empty table is still provided, because that",
  "// is what tells the boot-time reader \"this bundle WAS built with web, it just",
  '// has no pages" — as opposed to a bundle built without web at all, where no',
  "// barrel runs and the manifest stays absent.",
  "providePageManifest({ pages: [] });",
  "",
].join("\n");

async function writeBarrel(productionDir: string, contents: string): Promise<string> {
  const barrelFile = path.join(productionDir, "pages.ts");

  await fs.promises.mkdir(productionDir, { recursive: true });
  await fs.promises.writeFile(barrelFile, contents, "utf-8");

  return barrelFile;
}

/**
 * Discovers the page graph, runs the tripwire, and writes
 * `<productionDir>/pages.ts`.
 *
 * Zero pages is NOT an error, and it is NOT silence either: the barrel is
 * written anyway carrying an empty table, so "configured with web, no pages"
 * reaches the runtime as a fact instead of looking identical to "never built
 * with web". The run also says so out loud (no silent caps). What the caller
 * skips on zero pages is the CLIENT bundle — no pages means nothing to
 * hydrate.
 */
export async function generatePagesBarrel(
  options: GeneratePagesBarrelOptions,
): Promise<GeneratePagesBarrelResult> {
  const { appRoot, productionDir, clientDir } = options;
  const srcRoot = path.join(appRoot, options.srcDir ?? "src");
  const webRoots = discoverWebRoots(srcRoot);
  const discovered = discoverPages({ appRoot, srcDir: options.srcDir });

  if (discovered.length === 0) {
    console.log("web configured, 0 pages");

    return {
      pageCount: 0,
      barrelFile: await writeBarrel(productionDir, EMPTY_BARREL_CONTENTS),
      contents: EMPTY_BARREL_CONTENTS,
    };
  }

  assertNoViteOnlyImports(webRoots, appRoot);

  const appFile = path.join(srcRoot, "web", "root.tsx");

  if (!isFile(appFile)) {
    throw new Error(
      `Cannot generate the page barrel: ${discovered.length} page(s) were discovered but the application root ` +
        `component "${toPosix(path.relative(appRoot, appFile))}" does not exist. Every page renders inside it.`,
    );
  }

  const layoutIdentifiers = new Map<string, string>();
  const pages: BarrelPage[] = [];

  for (const [index, page] of discovered.entries()) {
    const layouts = page.layouts.map((layoutFile) => {
      let identifier = layoutIdentifiers.get(layoutFile);

      if (identifier === undefined) {
        identifier = `l${layoutIdentifiers.size}`;
        layoutIdentifiers.set(layoutFile, identifier);
      }

      return { identifier, sourceFile: layoutFile };
    });

    pages.push({ identifier: `p${index}`, sourceFile: page.pageFile, layouts });
  }

  const importLines = [
    `import * as app from ${quote(importSpecifierFor(productionDir, appFile))};`,
    ...[...layoutIdentifiers.entries()].map(
      ([layoutFile, identifier]) =>
        `import * as ${identifier} from ${quote(importSpecifierFor(productionDir, layoutFile))};`,
    ),
    ...pages.map(
      (page) =>
        `import * as ${page.identifier} from ${quote(importSpecifierFor(productionDir, page.sourceFile))};`,
    ),
  ];

  const relativeToApp = (file: string) => quote(toPosix(path.relative(appRoot, file)));

  const pageEntries = pages.map((page) => {
    const layouts = page.layouts
      .map((layout) => `{ module: ${layout.identifier}, sourceFile: ${relativeToApp(layout.sourceFile)} }`)
      .join(", ");

    return [
      "  {",
      `    module: ${page.identifier},`,
      `    sourceFile: ${relativeToApp(page.sourceFile)},`,
      `    layouts: [${layouts}],`,
      "  },",
    ].join("\n");
  });

  const contents = [
    ...BARREL_HEADER,
    ...importLines,
    "",
    "providePageManifest({",
    `  clientDir: ${quote(clientDir)},`,
    `  app: { module: app, sourceFile: ${relativeToApp(appFile)} },`,
    "  pages: [",
    ...pageEntries.map((entry) =>
      entry
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    ),
    "  ],",
    "});",
    "",
  ].join("\n");

  return {
    pageCount: pages.length,
    barrelFile: await writeBarrel(productionDir, contents),
    contents,
  };
}
