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
import { parse } from "@babel/parser";
import { normalizeRoutePath, type ConnectorEsbuildPatch } from "@warlock.js/core";
import {
  discoverPages,
  discoverWebRoots,
  isDiscoveredRoutablePage,
  isFile,
  toPosix,
  walkFiles,
} from "./discover-pages";
import {
  isNotFoundPageFile,
  NOT_FOUND_ROUTE_NAME,
  NOT_FOUND_ROUTE_PATH,
} from "../server/not-found-page";

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
 * Declared BEFORE the patch that reads it. `const` is hoisted but sits in the
 * temporal dead zone, and the patch below is an object literal evaluated at
 * module load — reading this from further down the file would throw.
 */
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

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
  /**
   * Stylesheets compile to NOTHING in the server bundle, rather than failing it.
   *
   * `root.tsx` importing `./app.css` is how Tailwind — and every other CSS
   * pipeline — is normally wired, so rejecting it meant the framework could not
   * build a styled application at all. But the server has no use for the bytes:
   * it renders HTML, and all it ever needs of a stylesheet is a URL to put in a
   * `<link>`. The CSS itself belongs to the CLIENT bundle, which Vite builds
   * from the same `root.tsx` and which handles CSS natively.
   *
   * So the import stays in the user's source, the server drops it, and Vite
   * emits the real asset. Nothing is silently lost: a stylesheet that does not
   * exist still fails the client build, loudly, where it matters.
   */
  loader: Object.fromEntries(
    STYLE_EXTENSIONS.map((extension) => [extension, "empty" as const]),
  ) as ConnectorEsbuildPatch["loader"],
};

/** Line appended to section 4 of the generated production entry, after `./routes`. */
export const WEB_ENTRY_IMPORT = 'await import("./pages");';

const REMEDY =
  "move the static file into the application's public/ directory and reference " +
  "it by its root URL instead (for example, public/logo.svg becomes /logo.svg). " +
  "The production server build does not compile static-asset imports, ?raw/?url " +
  "queries, or import.meta.url in the page graph in 5.2";

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
  /** App-root-public file paths copied into the production client directory. */
  publicFiles?: readonly string[];
};

export type GeneratePagesBarrelResult = {
  /** How many `*.page.tsx` files discovery found under the page root. */
  pageCount: number;
  /** Absolute path of the written barrel. Always written when this runs at all. */
  barrelFile: string;
  /** The written barrel source. */
  contents: string;
  /** The build-time route surface persisted beside the production output. */
  pageRoutes: PageRoutesManifest;
};

export type PageRouteManifestEntry = {
  method: "GET";
  path: string;
  name: string;
  source: string;
};

export type PageRoutesManifest = {
  version: 1;
  routes: PageRouteManifestEntry[];
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
        "static assets, `?raw`/`?url` queries and `import.meta.url` are not supported there. " +
        "(Stylesheets ARE supported: the server bundle drops them and the client bundle emits them.) " +
        `To fix: ${REMEDY}.`,
    );
    this.name = "WebPageGraphUnsupportedImportError";
  }
}

const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Blank every comment, preserving byte offsets.
 *
 * The scan below is regex over source text, so without this a specifier written
 * inside a comment is indistinguishable from a real import. That is not
 * hypothetical: documenting this very restriction — writing `import "./app.css"`
 * in a doc comment to explain why it is unsupported — failed the build, and the
 * error then insisted the file imported a stylesheet that it did not import.
 * Removing the real import did not help, because the comment was the match.
 *
 * Comments are replaced with spaces rather than deleted so every subsequent
 * offset, and therefore every line number in anything reported from here,
 * stays exactly where it was.
 *
 * A parse failure is deliberately NOT fatal: this function's job is to find
 * hazards, not to validate syntax. esbuild reports a genuine syntax error far
 * better than we would, and failing here would replace its clear message with a
 * worse one. On a parse failure the raw source is scanned — the pre-existing
 * behaviour, false positives and all.
 */
function withoutComments(source: string): string {
  try {
    const ast = parse(source, {
      sourceType: "module",
      errorRecovery: true,
      plugins: ["typescript", "jsx", "decorators-legacy"],
    });

    let stripped = source;

    for (const comment of ast.comments ?? []) {
      const { start, end } = comment as { start: number; end: number };

      stripped =
        stripped.slice(0, start) + " ".repeat(end - start) + stripped.slice(end);
    }

    return stripped;
  } catch {
    return source;
  }
}

/** Expects source whose comments have already been blanked by {@link withoutComments}. */
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

  /*
    STYLESHEETS ARE NOT A HAZARD — see `loader` in WEB_ESBUILD_PATCH above.

    They used to be rejected here, which meant `import "./app.css"` in
    `root.tsx` — the ordinary way to wire Tailwind or any other CSS pipeline —
    failed the build outright. The server bundle now compiles them to nothing,
    because the server only ever needs a stylesheet's URL, and the client bundle
    that Vite builds from the same sources emits the real asset.

    STYLE_EXTENSIONS is still the single list both halves read from, so the set
    esbuild stubs and the set this check tolerates cannot drift apart.
  */

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
 * LIMITATIONS, stated on purpose — BOTH directions, because stating only one
 * is what made the other one expensive to find:
 *
 * FALSE NEGATIVES. This is a FILE-LEVEL scan of the `.ts`/`.tsx` sources under
 * the discovered web roots — it is not transitive resolution. A page that
 * imports a workspace package which itself imports CSS is not caught here; that
 * failure surfaces at esbuild time instead.
 *
 * FALSE POSITIVES. The scan is regex over source text, so anything that LOOKS
 * like a specifier counts. Comments are blanked first ({@link withoutComments})
 * because a documented example used to fail the build while insisting on an
 * import that was not there. String and template literals are NOT blanked —
 * they cannot be, since real specifiers are string literals — so a specifier
 * inside a template literal (a code sample in a docs page, say) still matches.
 * Rare, and it fails loudly rather than silently, but it is not impossible.
 */
export function assertNoViteOnlyImports(webRoots: readonly string[], appRoot: string): void {
  for (const webRoot of webRoots) {
    const sources = walkFiles(
      webRoot,
      (fileName) => fileName.endsWith(".ts") || fileName.endsWith(".tsx"),
    );

    for (const sourceFile of sources) {
      // Comments stripped ONCE, and reused by both checks below: `import.meta.url`
      // was as blind to comments as the specifier scan was, and mentioning it in
      // prose — as this very file does — would have failed the build.
      const source = withoutComments(fs.readFileSync(sourceFile, "utf-8"));
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

type BarrelPage = {
  identifier: string;
  sourceFile: string;
  layouts: { identifier: string; sourceFile: string }[];
};

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

function emptyPageBarrelContents(clientDir: string, publicFiles: readonly string[]): string {
  if (publicFiles.length === 0) return EMPTY_BARREL_CONTENTS;

  return [
    ...BARREL_HEADER,
    "",
    "// Zero pages were discovered, but app-owned public files still belong to",
    "// the production browser surface and are served from the copied client tree.",
    "providePageManifest({",
    `  clientDir: ${quote(clientDir)},`,
    `  publicFiles: ${JSON.stringify([...publicFiles])},`,
    "  pages: [],",
    "});",
    "",
  ].join("\n");
}

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
  const { appRoot, productionDir, clientDir, publicFiles = [] } = options;
  const srcRoot = path.join(appRoot, options.srcDir ?? "src");
  const webRoots = discoverWebRoots(srcRoot);
  const discovered = discoverPages({ appRoot, srcDir: options.srcDir });
  const routablePages = discovered.filter(isDiscoveredRoutablePage);
  const errorPage = discovered.find((page) => page.type === "error");

  if (discovered.length === 0) {
    console.log("web configured, 0 pages");
    const contents = emptyPageBarrelContents(clientDir, publicFiles);

    return {
      pageCount: 0,
      barrelFile: await writeBarrel(productionDir, contents),
      contents,
      pageRoutes: { version: 1, routes: [] },
    };
  }

  assertNoViteOnlyImports(webRoots, appRoot);

  const appFile = path.join(srcRoot, "web", "root.tsx");

  if (routablePages.length > 0 && !isFile(appFile)) {
    throw new Error(
      `Cannot generate the page barrel: ${discovered.length} page(s) were discovered but the application root ` +
        `component "${toPosix(path.relative(appRoot, appFile))}" does not exist. Every page renders inside it.`,
    );
  }

  const layoutIdentifiers = new Map<string, string>();
  const pages: BarrelPage[] = [];
  // Persisted paths run through the ROUTER's own `normalizeRoutePath`, the
  // single definition of a route path's canonical form. Discovery derives these
  // from the filesystem and never registers anything, so without this the
  // manifest records a spelling the router never serves — the catch-all is
  // literally `"*"` here and `"/*"` once registered — and `warlock routes:diff`
  // reports drift on an untouched checkout right after a successful build.
  const pageRoutes: PageRoutesManifest = {
    version: 1,
    routes: [
      ...routablePages.filter((page) => !isNotFoundPageFile(page.pageFile)).map((page) => ({
      method: "GET" as const,
      path: normalizeRoutePath(page.routePath),
      name: page.routeName,
      source: toPosix(path.relative(appRoot, page.pageFile)),
      })),
      {
        method: "GET" as const,
        path: normalizeRoutePath(NOT_FOUND_ROUTE_PATH),
        name: NOT_FOUND_ROUTE_NAME,
        source: routablePages.find((page) => isNotFoundPageFile(page.pageFile)) === undefined
          ? "\u0000warlock:framework-default-404"
          : toPosix(path.relative(appRoot, routablePages.find((page) => isNotFoundPageFile(page.pageFile))!.pageFile)),
      },
    ],
  };

  for (const [index, page] of routablePages.entries()) {
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
    ...(routablePages.length === 0
      ? []
      : [`import * as app from ${quote(importSpecifierFor(productionDir, appFile))};`]),
    ...(errorPage === undefined
      ? []
      : [`import * as errorPage from ${quote(importSpecifierFor(productionDir, errorPage.pageFile))};`]),
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
    ...(routablePages.length === 0 && publicFiles.length === 0
      ? []
      : [`  clientDir: ${quote(clientDir)},`]),
    ...(publicFiles.length === 0
      ? []
      : [`  publicFiles: ${JSON.stringify([...publicFiles])},`]),
    ...(routablePages.length === 0 ? [] : [`  app: { module: app, sourceFile: ${relativeToApp(appFile)} },`]),
    ...(errorPage === undefined
      ? []
      : [`  errorPage: { module: errorPage, sourceFile: ${relativeToApp(errorPage.pageFile)} },`]),
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
    pageRoutes,
  };
}
