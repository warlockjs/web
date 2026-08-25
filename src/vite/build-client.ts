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
   * the build layout (`<outdir>/client`, contract §1), so it passes the
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
    throw new Error(`Cannot build the hydration client: entry "${entry.sourcePath}" is not a file.`);
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
