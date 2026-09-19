import { statSync } from "node:fs";
import path from "node:path";
import type { AliasOptions, PluginOption, Rollup } from "vite";
import { createHydrationClientEntry, type HydrationClientEntry } from "./hydration-entries";

export interface BuildHydrationClientOptions {
  /** `@warlock.js/web` root containing the packaged or checkout hydration entry. */
  webRoot: string;
  /**
   * Absolute output directory for the client bundle — REQUIRED.
   *
   * Was hardcoded to `<webRoot>/dist/client`, which wrote the artifacts into
   * the framework package rather than the app's build output. The caller owns
   * the build layout (`<outdir>/client`), so it passes the
   * directory; `manifestPath` is derived from it.
   */
  outDir: string;
  /** The caller-composed projection and boundary-gate plugin pipeline. */
  plugins: readonly PluginOption[];
  /** The caller-owned application and workspace source aliases. */
  resolveAliases: AliasOptions;
  /** Optional peers that must remain external to this bundler pipeline. */
  external?: Rollup.ExternalOption;
}

export type HydrationClientBuildOutput = Rollup.RollupOutput | Rollup.RollupOutput[];

/**
 * The vendor chunk name every React runtime module is pinned to.
 *
 * `resolveHydrationClientModulePreloadUrls` (`../server/hydration-client-url.ts`)
 * names this exact chunk when it exists — not by pattern-matching the
 * manifest's filenames, which carry a content hash this constant never does —
 * so the build and the runtime preload reader share ONE name rather than two
 * copies of the same string.
 */
export const VENDOR_REACT_CHUNK_NAME = "vendor-react";

/**
 * React, ReactDOM, the scheduler React depends on, and `react/jsx-runtime` /
 * `react/jsx-dev-runtime` (both resolve to files under `node_modules/react/`,
 * so the `react` branch below already covers them) into ONE `vendor-react`
 * chunk, separate from the Warlock runtime and from every page chunk.
 *
 * WHY A SEPARATE CHUNK AT ALL (card 53f8647e). Before this, the single
 * `hydration-*.js` entry bundled React + ReactDOM + the scheduler + the
 * Warlock client runtime together. Every app deploy re-bundles the Warlock
 * runtime (it changes with the app's own pages), which re-hashes the WHOLE
 * entry filename — so the browser re-downloaded React itself on every
 * deploy, even though React had not changed. Pulling the rarely-changing
 * vendor code into its own chunk gives it a stable hash across deploys that
 * only touch app code, so returning visitors serve it from cache.
 *
 * WHY A PATTERN ON THE MODULE ID, NOT AN EXPLICIT PACKAGE LIST. Rollup's
 * `manualChunks` receives the fully resolved absolute module id, so matching
 * `node_modules/<pkg>/` segments is the same technique Vite's own vendor
 * splitting recipes use, and it is resilient to nested/hoisted installs
 * (pnpm's `.pnpm/react@.../node_modules/react/...` still contains a bare
 * `node_modules/react/` segment).
 *
 * WHY EVERYTHING ELSE RETURNS `undefined` RATHER THAN A NAME. `undefined`
 * tells Rollup "no opinion — chunk this the default way", which is exactly
 * what keeps the Warlock runtime inside the entry and keeps each page's own
 * module in its own per-page chunk (dynamic `import()` boundaries, already
 * how `buildWarlockHydrationClient`'s page registry works). Naming a chunk
 * for the runtime or for pages here would be a SECOND chunking decision
 * competing with Rollup's automatic one, which is precisely the "don't
 * change anything else about chunking" the card calls out.
 */
export function warlockHydrationManualChunks(id: string): string | undefined {
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
    return VENDOR_REACT_CHUNK_NAME;
  }

  return undefined;
}

export interface BuildHydrationClientResult {
  entry: HydrationClientEntry;
  outDir: string;
  manifestPath: string;
  output: HydrationClientBuildOutput;
}

function assertEntryFile(entry: HydrationClientEntry): void {
  let entryStat: ReturnType<typeof statSync>;

  try {
    entryStat = statSync(entry.sourcePath);
  } catch (error) {
    throw new Error(
      `Cannot build the hydration client: entry "${entry.sourcePath}" is missing or unreadable.`,
      { cause: error },
    );
  }

  if (!entryStat.isFile()) {
    throw new Error(
      `Cannot build the hydration client: entry "${entry.sourcePath}" is not a file.`,
    );
  }
}

function assertBuildOptions(options: BuildHydrationClientOptions): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("Cannot build the hydration client: options are required.");
  }

  if (!Array.isArray(options.plugins) || options.plugins.length === 0) {
    throw new TypeError(
      "Cannot build the hydration client: the caller must provide its composed boundary plugins.",
    );
  }

  if (options.resolveAliases === undefined || options.resolveAliases === null) {
    throw new TypeError(
      "Cannot build the hydration client: the caller must provide its resolve aliases.",
    );
  }

  // An EMPTY table is rejected too, and that is the whole point of this branch.
  //
  // The not-null check above looks like it already covers a missing alias table.
  // It did not: the call site read `options.aliases ?? {}`, and `??` manufactures
  // an empty object that is neither undefined nor null — so the guard passed and
  // the build proceeded misconfigured, failing much later with a bare Rollup
  // "failed to resolve import" that named none of this.
  //
  // An app whose source uses alias imports cannot be built with zero aliases, so
  // absent and present-but-empty are the same error and must be reported the same
  // way, here, by name.
  if (
    (Array.isArray(options.resolveAliases) && options.resolveAliases.length === 0) ||
    (!Array.isArray(options.resolveAliases) && Object.keys(options.resolveAliases).length === 0)
  ) {
    throw new TypeError(
      "Cannot build the hydration client: the resolve alias table is empty. " +
        "App source that imports via `web/*` or `app/*` cannot resolve without it.",
    );
  }

  if (typeof options.outDir !== "string" || options.outDir.trim().length === 0) {
    throw new TypeError(
      "Cannot build the hydration client: the caller must provide an absolute outDir.",
    );
  }
}

/**
 * Builds the one browser hydration entry. Vite is an optional peer and is
 * imported only after the caller explicitly invokes this build operation.
 */
export async function buildHydrationClient(
  options: BuildHydrationClientOptions,
): Promise<BuildHydrationClientResult> {
  assertBuildOptions(options);

  const entry = createHydrationClientEntry(options.webRoot);
  assertEntryFile(entry);

  const outDir = path.resolve(options.outDir);
  const manifestPath = path.join(outDir, ".vite/manifest.json");
  const { build } = await import("vite");
  const viteResult = await build({
    root: options.webRoot,
    appType: "custom",
    configFile: false,
    plugins: [...options.plugins],
    resolve: { alias: options.resolveAliases },
    build: {
      copyPublicDir: false,
      emptyOutDir: true,
      manifest: true,
      outDir,
      target: "es2022",
      rollupOptions: {
        external: options.external,
        input: { [entry.name]: entry.sourcePath },
        output: {
          assetFileNames: "assets/[name]-[hash][extname]",
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js",
          format: "es",
          // No app-supplied `manualChunks` exists to compose with today: the
          // caller-configurable surface here is `options.plugins`
          // (`BuildHydrationClientOptions.plugins`) and Vite's own plugin
          // `config`/`config.build.rollupOptions` merge hooks — a plugin
          // wanting its own vendor split can still hook `config` before this
          // one runs. There is no separate `rollupOptions`/`manualChunks`
          // input threaded onto `BuildHydrationClientOptions` for this
          // function to overwrite, so nothing to compose with yet.
          manualChunks: warlockHydrationManualChunks,
        },
      },
      watch: null,
    },
  });

  if (!Array.isArray(viteResult) && !("output" in viteResult)) {
    await viteResult.close();
    throw new Error("Cannot build the hydration client: Vite unexpectedly returned a watcher.");
  }

  return { entry, outDir, manifestPath, output: viteResult };
}
