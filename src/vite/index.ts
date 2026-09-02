/**
 * `@warlock.js/web/vite` — build-tooling subpath, kept separate from the
 * runtime barrel (`@warlock.js/web`) so importing it never pulls `vite` into
 * a project that doesn't build with Vite.
 */
import { parse } from "@babel/parser";
import path from "node:path";
import type { Plugin } from "vite";
import {
  buildHydrationClient,
  type BuildHydrationClientOptions,
  type BuildHydrationClientResult,
} from "./build-client";
import {
  gateAResolve,
  isAppSourcePath,
  isRecognizedUniversalSurface,
  isServerFile,
  isWithinModuleWebFolder,
} from "./gate-a-resolve";
import { createPublicEnvTracker, gateBSecrets } from "./gate-b-secrets";
import { gateCVerify } from "./gate-c-verify";
import {
  clientPageRegistry,
  type ClientPageRegistryPluginOptions,
} from "./page-registry-plugin";
import { isProjectableFile, projectModule, projection } from "./projection";

export { buildHydrationClient } from "./build-client";
export type {
  BuildHydrationClientOptions,
  BuildHydrationClientResult,
  HydrationClientBuildOutput,
} from "./build-client";
export { gateAResolve } from "./gate-a-resolve";
export type {
  EnvironmentClassifier,
  EnvironmentClassifierOptions,
  WarlockEnvironment,
} from "./gate-a-resolve";
export { createPublicEnvTracker, gateBSecrets } from "./gate-b-secrets";
export type { PublicEnvTracker } from "./gate-b-secrets";
export {
  buildPublicEnvManifest,
  findLeakedServerExports,
  findLeakedServerImportEdges,
  gateCVerify,
} from "./gate-c-verify";
export type {
  GateCOptions,
  PublicEnvManifestEntry,
  ServerExportLeak,
  ServerImportEdgeLeak,
} from "./gate-c-verify";
export {
  HYDRATION_CLIENT_ENTRY_NAME,
  createHydrationClientEntry,
} from "./hydration-entries";
export type { HydrationClientEntry } from "./hydration-entries";
export {
  CLIENT_PAGE_REGISTRY_ID,
  clientPageRegistry,
  invalidateClientPageRegistry,
  RESOLVED_CLIENT_PAGE_REGISTRY_ID,
} from "./page-registry-plugin";
export type { ClientPageRegistryPluginOptions } from "./page-registry-plugin";
export { projection, ProjectionAmbiguityError } from "./projection";
export type { ProjectionResult } from "./projection";

export type WarlockClientBoundaryOptions = Parameters<
  typeof gateAResolve
>[0] & {
  beforePageHotUpdate?: ClientPageRegistryPluginOptions["beforePageHotUpdate"];
};

export type BuildWarlockHydrationClientOptions = Readonly<{
  appRoot: string;
  webRoot: string;
  /** Absolute client output dir — threaded to `buildHydrationClient` (`<outdir>/client`). */
  outDir: string;
  resolveAliases: BuildHydrationClientOptions["resolveAliases"];
  external?: BuildHydrationClientOptions["external"];
  /** App-configured plugins, appended after Warlock's client-boundary pipeline. */
  plugins?: BuildHydrationClientOptions["plugins"];
}>;

type SsrBoundaryState = {
  readonly appRoot: string;
  readonly clientBoundModules: Set<string>;
  readonly clientImportsByModule: Map<string, Set<string>>;
};

function moduleKey(id: string): string {
  return id.split("?")[0].replace(/\\/g, "/");
}

const CODE_MODULE_EXTENSION = /\.([cm]?[jt]sx?)$/;

function isStatelessClientSurface(id: string, appRoot: string): boolean {
  const bare = moduleKey(id);
  if (!isAppSourcePath(bare, appRoot)) return false;
  if (isServerFile(bare, appRoot)) return false;

  return (
    isProjectableFile(bare) ||
    isRecognizedUniversalSurface(bare) ||
    isWithinModuleWebFolder(bare, appRoot)
  );
}

function collectImportSpecifiers(code: string): Set<string> {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const imports = new Set<string>();

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    const record = node as Record<string, any>;
    if (
      (record.type === "ImportDeclaration" ||
        record.type === "ExportNamedDeclaration" ||
        record.type === "ExportAllDeclaration") &&
      record.source?.type === "StringLiteral"
    ) {
      imports.add(record.source.value);
    }
    if (
      record.type === "CallExpression" &&
      record.callee?.type === "Import" &&
      record.arguments?.[0]?.type === "StringLiteral"
    ) {
      imports.add(record.arguments[0].value);
    }
    if (
      record.type === "ImportExpression" &&
      record.source?.type === "StringLiteral"
    ) {
      imports.add(record.source.value);
    }

    for (const [key, child] of Object.entries(record)) {
      if (
        key === "type" ||
        key === "start" ||
        key === "end" ||
        key === "loc" ||
        key === "range" ||
        key.endsWith("Comments") ||
        key === "extra"
      ) {
        continue;
      }
      walk(child);
    }
  }

  walk(ast.program);
  return imports;
}

function clientViewOf(
  state: SsrBoundaryState,
  code: string,
  id: string,
): string | undefined {
  const key = moduleKey(id);
  if (
    !state.clientBoundModules.has(key) &&
    !isStatelessClientSurface(key, state.appRoot)
  ) {
    return undefined;
  }

  state.clientBoundModules.add(key);
  if (!CODE_MODULE_EXTENSION.test(key)) {
    state.clientImportsByModule.set(key, new Set());
    return code;
  }

  const clientCode = isProjectableFile(key)
    ? projectModule(code, key).code
    : code;
  state.clientImportsByModule.set(key, collectImportSpecifiers(clientCode));
  return clientCode;
}

function markResolvedClientModule(
  state: SsrBoundaryState,
  resolved: { id: string } | string | null | false | void,
): void {
  if (!resolved) return;
  const id = typeof resolved === "string" ? resolved : resolved.id;
  if (!id.includes("\0")) state.clientBoundModules.add(moduleKey(id));
}

function isServerEnvironment(context: {
  environment?: { config: { consumer?: string } };
}): boolean {
  return context.environment?.config.consumer === "server";
}

/**
 * Keeps the production/client pipeline byte-identical, while giving Gate A
 * and Gate B a validation-only view in Vite's development SSR environment.
 * SSR still evaluates the original source: only the gates receive the
 * projected client view, so loader/server exports retain their legitimate
 * server access while component-visible code is refused before evaluation.
 */
function clientEnvironmentOnly(
  plugin: Plugin,
  ssrState: SsrBoundaryState,
): Plugin {
  const validatesDevSsr =
    plugin.name === "warlock:gate-a-resolve" ||
    plugin.name === "warlock:gate-b-secrets";
  const originalTransform =
    typeof plugin.transform === "function"
      ? plugin.transform
      : plugin.transform?.handler;
  const originalResolveId =
    typeof plugin.resolveId === "function"
      ? plugin.resolveId
      : plugin.resolveId?.handler;
  const originalBuildStart =
    typeof plugin.buildStart === "function"
      ? plugin.buildStart
      : plugin.buildStart?.handler;

  return {
    ...plugin,
    applyToEnvironment(environment) {
      return (
        environment.config.consumer === "client" ||
        (validatesDevSsr && environment.config.consumer === "server")
      );
    },
    buildStart: originalBuildStart
      ? function (...args) {
          if (isServerEnvironment(this)) return;
          return originalBuildStart.apply(this, args);
        }
      : undefined,
    transform: originalTransform
      ? async function (code, id, options) {
          if (!isServerEnvironment(this)) {
            return originalTransform.call(this, code, id, options);
          }

          const clientCode = clientViewOf(ssrState, code, id);
          if (clientCode === undefined) return null;

          const transformed = await originalTransform.call(
            this,
            clientCode,
            id,
            {
              ...options,
              ssr: false,
            },
          );

          // Vite can externalize a package in the SSR environment before its
          // normal resolver walk offers that edge to a plugin. Gate A cannot
          // wait for that walk: validate every import that survived projection
          // now, while the original TypeScript source and importer are known.
          if (plugin.name === "warlock:gate-a-resolve" && originalResolveId) {
            for (const source of ssrState.clientImportsByModule.get(
              moduleKey(id),
            ) ?? []) {
              const resolved = await originalResolveId.call(this, source, id, {
                attributes: {},
                isEntry: false,
                ssr: false,
              });
              markResolvedClientModule(ssrState, resolved);
            }
          }

          return transformed;
        }
      : undefined,
    resolveId: originalResolveId
      ? async function (source, importer, options) {
          if (!isServerEnvironment(this)) {
            return originalResolveId.call(this, source, importer, options);
          }

          if (!importer) return null;
          const importerKey = moduleKey(importer);
          const isClientBound =
            ssrState.clientBoundModules.has(importerKey) ||
            isStatelessClientSurface(importerKey, ssrState.appRoot);
          if (!isClientBound) return null;

          const survivingImports =
            ssrState.clientImportsByModule.get(importerKey);
          if (survivingImports && !survivingImports.has(source)) return null;

          const resolved = await originalResolveId.call(
            this,
            source,
            importer,
            {
              ...options,
              ssr: false,
            },
          );
          markResolvedClientModule(ssrState, resolved);
          return resolved;
        }
      : undefined,
  };
}

/**
 * The composed client-build pipeline: projection
 * strips the 5 server exports first, THEN Gate B's `transform` checks
 * whatever source remains for inline secret reads, THEN Gate A's
 * `resolveId` judges whatever imports remain. Array order here is
 * `[projection(), gateBSecrets(), gateAResolve()]` to match Vite's own
 * pipeline shape (`transform` before `resolveId`), but array order alone
 * does not guarantee this — see the hook-ordering fact below, which is what
 * actually makes the composition correct.
 *
 * Empirically observed fact (via an instrumented real `vite.build()`, not
 * assumed from plugin array order): for a given module M, Vite/Rollup calls
 * `transform(M)` BEFORE it calls `resolveId` for any of M's own import
 * specifiers — because Rollup must parse M's post-transform source to even
 * discover which specifiers to resolve next. Concretely: `transform` ran on
 * `entry.page.tsx` first, and only after that did `resolveId("./dep", ...)`
 * fire for the import statement still present in the transformed code. A
 * consequence follows directly: if projection's `transform` removes an
 * import statement from a page module entirely (e.g. `loader`'s
 * `@warlock.js/core` import, stripped because `loader` itself is removed),
 * `resolveId` is never invoked for that specifier at all — Gate A doesn't
 * "let it pass", it never sees it. Gate A's `resolveId` only fires for
 * imports that survive projection's `transform`, which is exactly why a
 * component-level `@warlock.js/core` import (never touched by projection)
 * still reaches and is refused by Gate A.
 *
 * This is OBSERVED Rollup behavior, not a documented contract — a future
 * Vite/Rollup upgrade could invert it. Pinned by a
 * regression test (`index.spec.ts`, "D.3 hook ordering pin") that fails
 * loudly if the ordering ever inverts, and by the `vite` peer floor in
 * `web/package.json` (`>=7.3.5`, the version this was verified against). If
 * that test ever fails after a Vite bump: the failure mode of the ordering
 * assumption breaking is SAFE — projection would stop removing an import
 * statement Gate A still sees, so Gate A would refuse an import it used to
 * silently let a stripped server export take with it. That is a loud build
 * failure ("Gate A refused an import"), never a silent client-bundle leak.
 * Do NOT "fix" an apparent Gate A false-positive after a Vite upgrade by
 * weakening Gate A (e.g. widening what it lets through) — investigate
 * whether this ordering assumption broke instead; loosening Gate A to work
 * around it would turn a loud failure into the exact silent leak this
 * pipeline exists to prevent.
 *
 * Gate B is placed between the two for the same reason, but for a `transform`
 * hook rather than `resolveId`: within a plugin array, Rollup runs each
 * module's registered `transform` hooks in array order, each one receiving
 * the PREVIOUS plugin's output. Running Gate B after projection means it
 * inspects the POST-projection source — a `process.env.SECRET` read inside
 * `loader` (a server export, legitimately reading a real secret server-side)
 * is invisible to Gate B once projection has already removed `loader`
 * entirely, exactly as it should be: Gate B's job is to fence client-bound
 * code, and projection is what decides what counts as client-bound. A
 * component-level secret read is untouched by projection and still reaches
 * Gate B, which refuses it. Gate B does not depend on Gate A's `resolveId`
 * output at all (orthogonal concern, raw source vs. import paths), so its
 * position relative to Gate A is not load-bearing — it is placed before Gate
 * A only to keep both `transform` hooks adjacent in the array.
 *
 * Gate C (`gate-c-verify.ts`) runs last and only at `generateBundle` — after
 * the entire `transform`/`resolveId` build phase has completed for every
 * plugin, regardless of array position (a Rollup lifecycle fact, not
 * something this array order enforces). It verifies the EMITTED output the
 * other three produced: no server export survived as a top-level binding, no
 * import edge into a server-only package survived into the module graph, and
 * it emits the reviewable `PUBLIC_*` inlined-value manifest. `gateBSecrets` and `gateCVerify` share
 * one `PublicEnvTracker` instance so the manifest and Gate B's own unread-key
 * exclusion check agree by construction, not by coincidence.
 *
 * `clientPageRegistry()` is FIRST, ahead of projection. It contributes no
 * `transform` at all — only a `resolveId`/`load` pair for one synthetic id —
 * so it cannot displace or pre-empt any gate's inspection of any real file.
 * Two reasons for the position, one of which is not load-bearing and is
 * labelled as such:
 *
 * 1. Load-bearing: it must own `virtual:warlock/pages` before Gate A's
 *    `resolveId` (also `enforce: "pre"`) reaches its `this.resolve(...)` call
 *    for that specifier. Gate A's nested resolve would find it anyway, but
 *    routing the id through Gate A's importer-chain bookkeeping only to have
 *    it come back means a synthetic id can surface in a user-facing "Import
 *    chain:" message. Resolving it first keeps ownership of the id in one
 *    place.
 * 2. NOT load-bearing: the position relative to `projection()`. Projection is
 *    `enforce: "pre"` and selects by file BASENAME (`projection.ts:242-248`),
 *    so it transforms every `*.page.tsx` / `layout.tsx` / `root.tsx` that
 *    enters the graph regardless of who imported it or where this plugin sits.
 *    The registry emits absolute POSIX specifiers that Rollup resolves and
 *    loads as ORDINARY file modules — they are not inlined into the virtual
 *    module — so each one is transformed exactly as a page imported from a
 *    real file would be. Projection declines the virtual module itself
 *    (`\0virtual:warlock/pages` has no matching basename), which is correct:
 *    generated code has no server exports to strip.
 *
 * Point 2 is asserted, not assumed, by a real `vite.build()` in
 * `page-registry-plugin.spec.ts`: a fixture page whose `loader` — and only its
 * `loader` — imports a marker module that Gate A independently PERMITS, built
 * through this exact array, with the marker proven absent from every emitted
 * chunk while the page's own component text is proven present. Inspecting this
 * array's order would prove nothing about what reaches the browser.
 */
export function warlockClientBoundary(
  options: WarlockClientBoundaryOptions = {},
): Plugin[] {
  const tracker = createPublicEnvTracker();
  const ssrState: SsrBoundaryState = {
    appRoot: path.resolve(options.appRoot ?? process.cwd()),
    clientBoundModules: new Set(),
    clientImportsByModule: new Map(),
  };
  return [
    clientPageRegistry({
      appRoot: options.appRoot,
      beforePageHotUpdate: options.beforePageHotUpdate,
    }),
    projection(),
    gateBSecrets({ tracker }),
    gateAResolve(options),
    gateCVerify({ ...options, tracker }),
  ].map((plugin) => clientEnvironmentOnly(plugin, ssrState));
}

/**
 * Callable production seam: callers own their exact source aliases and the
 * app-root classification boundary, while this module owns the one canonical
 * projection/Gate B/Gate A/Gate C composition.
 */
export async function buildWarlockHydrationClient(
  options: BuildWarlockHydrationClientOptions,
): Promise<BuildHydrationClientResult> {
  return buildHydrationClient({
    webRoot: options.webRoot,
    outDir: options.outDir,
    resolveAliases: options.resolveAliases,
    external: options.external,
    plugins: [
      ...warlockClientBoundary({ appRoot: options.appRoot }),
      ...(options.plugins ?? []),
    ],
  });
}
