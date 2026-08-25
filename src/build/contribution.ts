/**
 * Web's build-time half — the object a `WebConnector` hands to
 * `warlock build` as its `build` contribution.
 *
 * KEPT DELIBERATELY LIGHT: everything this
 * module imports statically is a type or `node:path`. The heavy halves — the
 * filesystem discovery/barrel generator, and the Vite client build — are
 * `await import(...)`ed INSIDE the hooks, so a config file that merely
 * constructs the connector never drags Vite, React or the page graph into its
 * static import graph.
 *
 * {@link WebBuildOptions} carries JSON-SERIALIZABLE VALUES ONLY (constraint
 * B): no plugin instances, no functions, no class instances. Anything heavy is
 * constructed inside a hook after that hook's dynamic import.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ConnectorBuildContext,
  ConnectorBuildContribution,
  ConnectorBuildGenerateResult,
} from "@warlock.js/core";

export type WebBuildOptions = {
  /** Source directory name under the app root. Default: `"src"`. */
  srcDir?: string;
  /**
   * Absolute path to the `@warlock.js/web` package root, which holds the
   * hydration entry (packaged as `esm/hydration/index.mjs`, with a source
   * fallback at `src/hydration/index.ts` for this checkout).
   *
   * Defaults to this module's own package root, derived from `import.meta.url`
   * at emit time. Set it explicitly when the build process loads this module
   * through a transform that rewrites `import.meta` (e.g. a CJS config
   * pipeline) — the derivation is the only thing here that depends on it.
   *
   * Derived or configured, the root is VERIFIED at emit time against
   * `<root>/package.json`'s `name`; a root that is not `@warlock.js/web`
   * throws {@link WebPackageRootResolutionError} rather than being guessed at.
   */
  webRoot?: string;
  /**
   * NOT SUPPORTED. The client bundle always lands at `<build.outdir>/client`,
   * the layout the runtime half reads (`resolveHydrationClientUrl`) — the
   * runtime does not yet consult a relocated path. Setting this option throws
   * {@link ClientOutDirNotSupportedError}.
   */
  clientOutDir?: string;
  /** Client-build resolve aliases: specifier -> absolute path. */
  aliases?: Record<string, string>;
  /** Extra package names to keep external to the client bundle. */
  external?: string[];
};

function resolveClientOutDir(context: ConnectorBuildContext): string {
  return path.resolve(context.appRoot, context.options.outdir, "client");
}

/**
 * `build.clientOutDir` was set.
 *
 * The production runtime hardcodes where it reads the client bundle from
 * (`<outdir>/client`, via `resolveHydrationClientUrl`) — it does not yet
 * consult the build config for a relocated path. A build that honored a
 * custom `clientOutDir` would therefore produce an artifact the runtime
 * cannot find, silently. Rejected at build start, before any work happens,
 * rather than left to surface later as a missing-bundle failure in
 * production.
 */
export class ClientOutDirNotSupportedError extends Error {
  public constructor() {
    super(
      '"build.clientOutDir" is not supported: the production server reads the client bundle ' +
        "from its default location and does not consult this option, so a build honoring it " +
        "would produce an artifact production cannot serve correctly. Remove " +
        '"build.clientOutDir" from the build config.',
    );
    this.name = "ClientOutDirNotSupportedError";
  }
}

/** The package name every candidate web root must declare to be one. */
const WEB_PACKAGE_NAME = "@warlock.js/web";

/**
 * The resolved `@warlock.js/web` root is not that package.
 *
 * Same posture as the manifest resolver's three named errors: a root that
 * cannot be proven is REJECTED, never quietly
 * repaired by walking upwards or falling back to `process.cwd()`. A wrong root
 * would otherwise surface much later as an unintelligible Vite entry failure.
 */
export class WebPackageRootResolutionError extends Error {
  public constructor(webRoot: string, reason: string, cause?: unknown) {
    super(
      `Cannot resolve the "${WEB_PACKAGE_NAME}" package root: "${webRoot}" ${reason}. ` +
        "Pass `webRoot` explicitly in the web build options to point at the package root " +
        `whose package.json declares "name": "${WEB_PACKAGE_NAME}".`,
      { cause },
    );
    this.name = "WebPackageRootResolutionError";
  }
}

/**
 * Proves that `webRoot` really is the `@warlock.js/web` package root by reading
 * `<webRoot>/package.json` and matching its `name`. Returns the path unchanged.
 */
export function assertWebPackageRoot(webRoot: string): string {
  const manifestPath = path.join(webRoot, "package.json");

  let raw: string;

  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (error) {
    throw new WebPackageRootResolutionError(webRoot, "has no readable package.json", error);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WebPackageRootResolutionError(
      webRoot,
      "has a package.json that is not valid JSON",
      error,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebPackageRootResolutionError(
      webRoot,
      "has a package.json whose root is not a JSON object",
    );
  }

  const name = (parsed as { name?: unknown }).name;

  if (name !== WEB_PACKAGE_NAME) {
    throw new WebPackageRootResolutionError(
      webRoot,
      `declares package name ${JSON.stringify(name)}, not "${WEB_PACKAGE_NAME}"`,
    );
  }

  return webRoot;
}

export async function resolveWebPackageRoot(configured: string | undefined): Promise<string> {
  if (configured !== undefined) {
    return assertWebPackageRoot(path.resolve(configured));
  }

  const { fileURLToPath } = await import("node:url");

  // `web/src/build/contribution.ts` published as `web/esm/build/contribution.js`
  // — two levels up is the package root under both layouts.
  return assertWebPackageRoot(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
}

/**
 * Builds web's `ConnectorBuildContribution`.
 *
 * `generate` writes the page barrel into `ctx.productionDir` and patches
 * esbuild; `emit` produces the client bundle esbuild cannot. The two share one
 * closure fact — how many pages exist — because a build with zero pages must
 * skip the client bundle rather than emit an orphan one. `generate` itself does
 * NOT skip: the barrel and its entry import are emitted either way, so the
 * runtime can tell a page-free web build from a build without web.
 */
export function createWebBuildContribution(
  options: WebBuildOptions = {},
): ConnectorBuildContribution {
  if (options.clientOutDir !== undefined) {
    throw new ClientOutDirNotSupportedError();
  }

  let pageCount = 0;

  return {
    async generate(context: ConnectorBuildContext): Promise<ConnectorBuildGenerateResult | void> {
      const { generatePagesBarrel, WEB_ENTRY_IMPORT, WEB_ESBUILD_PATCH } = await import(
        "./generate-pages-barrel"
      );

      const result = await generatePagesBarrel({
        appRoot: context.appRoot,
        productionDir: context.productionDir,
        srcDir: options.srcDir,
        // Derived from `resolveClientOutDir` — the SAME function `emit` passes
        // to the Vite build below — so the path baked into the manifest and
        // the path the bundle is written to are one expression, not two that
        // happen to agree today.
        // POSIX-normalised inline rather than via the generator's `toPosix`:
        // this module's static graph is `node:path` and types only, and the
        // generator is reached by `await import` precisely to keep it that way.
        clientDir: path
          .relative(context.appRoot, resolveClientOutDir(context))
          .split(path.sep)
          .join("/"),
      });

      pageCount = result.pageCount;

      // Contributed unconditionally, zero pages included: the barrel is always
      // written, and the entry has to IMPORT it for the empty table to reach
      // the runtime. Withholding this line on zero pages would leave the
      // manifest absent, which is the runtime's signal for "never built with
      // web" — the exact confusion the always-written barrel removes.
      return { entryImports: [WEB_ENTRY_IMPORT], esbuild: WEB_ESBUILD_PATCH };
    },

    async emit(context: ConnectorBuildContext): Promise<void> {
      if (pageCount === 0) {
        return;
      }

      const { buildWarlockHydrationClient } = await import("../vite");
      const { appConventionAliases } = await import("../vite/app-convention-aliases");

      // The app-tree convention (`web/*`, `app/*`) the dev server installs must
      // also reach the production build, from the SAME definition — see
      // `app-convention-aliases.ts`. Caller-supplied aliases come first so a
      // caller can win a conflict, matching the dev server's ordering.
      const callerAliases = Object.entries(options.aliases ?? {}).map(([find, replacement]) => ({
        find,
        replacement,
      }));

      await buildWarlockHydrationClient({
        appRoot: context.appRoot,
        webRoot: await resolveWebPackageRoot(options.webRoot),
        outDir: resolveClientOutDir(context),
        resolveAliases: [
          ...callerAliases,
          ...appConventionAliases(path.join(context.appRoot, options.srcDir ?? "src")),
        ],
        external: options.external,
      });
    },
  };
}
