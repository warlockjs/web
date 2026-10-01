import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DevelopmentAppModules, DevelopmentModelModules } from "@warlock.js/core";
import { normalizePath, type Plugin } from "vite";
import { createAppModuleGraphScanner } from "./app-module-graph-scan";
import { isClientFile } from "./gate-a-resolve";
import {
  invalidateWithImporters,
  isSsrEnvironment,
  moduleIdPath,
  trampoline,
  versionedUrl,
} from "./dev-module-bridge";
import { isProjectableFile } from "./projection";

/**
 * Only `.ts` / `.tsx` carry the loader hook's `?v=<N>` stamp
 * (`core/src/dev-server/loader/resolve-hook.ts`). Any other extension would be
 * a DIFFERENT native instance from the one core holds the moment a query is
 * appended, so it can never be bridged.
 */
const HOOK_VERSIONED_EXTENSION = /\.tsx?$/;

/** A `.d.ts` is types only; nothing to evaluate. */
const DECLARATION_FILE = /\.d\.[cm]?tsx?$/;

/**
 * Source that only Vite can evaluate. `import.meta.env` / `.glob` / `.hot` are
 * Vite's own transforms, and an import with a query suffix (`?raw`, `?url`,
 * `?worker`, ...) or of a non-code file (stylesheet, image, font, json) is
 * resolved and loaded by Vite plugins that Node's loader does not have. Core's
 * native import would fail on, or silently change, all of them, so a module
 * written that way stays inside Vite's graph exactly as before.
 *
 * A textual scan on purpose: a false positive (the text inside a comment)
 * only keeps a module on the old path; a false negative would break it.
 */
const VITE_ONLY_META = /import\.meta\.(?:env|glob|hot)\b/;
const VITE_ONLY_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])[^"'\n]*(?:\?[^"'\n]*|\.(?:css|scss|sass|less|styl|stylus|pcss|postcss|json|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|pdf|txt|md))\1/i;

export function requiresViteToEvaluate(source: string): boolean {
  return VITE_ONLY_META.test(source) || VITE_ONLY_IMPORT.test(source);
}

/** The shape of a module namespace the plugin needs: only whether `default` exists. */
type NativeNamespace = Record<string, unknown>;

type NativeImport = (url: string) => Promise<NativeNamespace>;

/**
 * Node's own `import()`. In the running dev server this module is evaluated by
 * Node itself, so the call reaches core's loader hook and Node's real module
 * cache — which is the point. A caller that is NOT Node-native (a test runner
 * with its own module graph) injects its own via `options.nativeImport`.
 */
const nativeImportOfNode: NativeImport = (url) => import(/* @vite-ignore */ url);

export type CoreAppModulesOptions = {
  /** Absolute `<appRoot>/src`. Only `<appSrcRoot>/app/**` is ever bridged. */
  appSrcRoot: string;
  /** Core's `development.appModules` carrier; the plugin is inert without it. */
  registry?: DevelopmentAppModules;
  /** Models keep their own, more precise, bridge — see `coreModelModules`. */
  modelModules?: DevelopmentModelModules;
  /**
   * Whether the SSR client-boundary mirror has already classified this module
   * as client-reachable. Such a module must stay inside Vite so Gate A/B keep
   * judging its original source and its imports.
   */
  isClientBound?: (id: string) => boolean;
  /** Test seam; defaults to Node's real `import()`. */
  nativeImport?: NativeImport;
};

function isInsideDirectory(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Makes Vite's development SSR graph read `src/app/**` code modules through
 * the SAME native `file://` instance core's loader hook already evaluated,
 * instead of inlining a second copy of them into the Vite graph.
 *
 * Two copies of a module mean two `AsyncLocalStorage`s, two caches and two
 * registries: whatever core's middleware stores on one side the Vite-evaluated
 * page loader can never read. The `load` hook returns a trampoline (see
 * {@link trampoline}) whose `file://...?v=<generation>` URL is exactly the one
 * the loader hook resolves, so Node answers with the existing instance. When
 * core bumps the file, the trampoline and everything that imports it are
 * invalidated and the next SSR import carries the new generation.
 *
 * Not bridged, and left to Vite exactly as before:
 *   - anything outside `<appSrcRoot>/app/` (so all of `src/web/**`),
 *   - `*.client.*` modules, page/layout/root files and `.setup.ts` sidecars,
 *   - ids that are not a plain `.ts` / `.tsx` file (queries, virtual, css, ...),
 *   - models (their own bridge owns them),
 *   - modules the SSR client-boundary mirror has marked client-reachable,
 *   - modules whose transitive import graph reaches `@warlock.js/web` (any
 *     subpath), anything under `src/web/**`, or source that needs Vite
 *     (`import.meta.env|glob|hot`, queried or non-code imports) — see
 *     {@link createAppModuleGraphScanner}.
 */
export function coreAppModules(options: CoreAppModulesOptions): Plugin {
  const { registry } = options;
  const appDirectory = path.resolve(options.appSrcRoot, "app");
  const nativeImport = options.nativeImport ?? nativeImportOfNode;
  const graph = createAppModuleGraphScanner({
    appSrcRoot: options.appSrcRoot,
    requiresViteToEvaluate,
  });
  const hasDefaultByUrl = new Map<string, boolean>();
  const bridgedIdsByUrl = new Map<string, Set<string>>();
  let unsubscribe: (() => void) | undefined;

  const dispose = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  async function hasDefaultExport(liveUrl: string): Promise<boolean> {
    const known = hasDefaultByUrl.get(liveUrl);
    if (known !== undefined) return known;

    // The very import the trampoline is about to make. It evaluates the module
    // now, once, in Node's cache, and core finds that same instance later.
    const hasDefault = Object.hasOwn(await nativeImport(liveUrl), "default");
    hasDefaultByUrl.set(liveUrl, hasDefault);

    return hasDefault;
  }

  return {
    name: "warlock:core-app-modules",
    // Before Vite's own file loader: this hook REPLACES the module's source, so
    // none of the transforms run on the original code. Everything a gate needs
    // to see is excluded above rather than reproduced here.
    enforce: "pre",
    applyToEnvironment: (environment) => environment.config.consumer === "server",
    async load(id, loadOptions) {
      if (!registry) return null;
      if (!isSsrEnvironment(this, loadOptions?.ssr)) return null;

      const absolutePath = moduleIdPath(id);
      if (!absolutePath) return null;
      if (!HOOK_VERSIONED_EXTENSION.test(absolutePath) || DECLARATION_FILE.test(absolutePath)) {
        return null;
      }
      if (!isInsideDirectory(appDirectory, absolutePath)) return null;
      if (absolutePath.split(/[\\/]/).includes("node_modules")) return null;
      if (isClientFile(absolutePath) || isProjectableFile(absolutePath)) return null;
      if (path.basename(absolutePath).endsWith(".setup.ts")) return null;
      if (options.modelModules?.get(absolutePath)) return null;
      if (options.isClientBound?.(id)) return null;

      // The module AND everything it transitively imports must be safe to hand
      // to Node; see `app-module-graph-scan.ts` (`@warlock.js/web` is the
      // headline reason). An unreadable file is Vite's to report.
      if (await graph.staysInVite(absolutePath)) return null;

      const entry = registry.get(absolutePath);
      const url = entry?.url ?? pathToFileURL(absolutePath).href;
      const liveUrl = versionedUrl(url, entry?.generation ?? 0);
      const hasDefault = await hasDefaultExport(liveUrl);

      const bridgedKey = url.toLowerCase();
      const bridgedIds = bridgedIdsByUrl.get(bridgedKey) ?? new Set<string>();
      bridgedIds.add(normalizePath(absolutePath));
      bridgedIds.add(normalizePath(id));
      bridgedIdsByUrl.set(bridgedKey, bridgedIds);

      return { code: trampoline(liveUrl, hasDefault), map: null };
    },
    configureServer(server) {
      if (!registry) return;

      unsubscribe = registry.subscribe((entry) => {
        graph.forget(fileURLToPath(entry.url));
        invalidateWithImporters(
          server,
          fileURLToPath(entry.url),
          bridgedIdsByUrl.get(entry.url.toLowerCase()) ?? new Set(),
        );
      });
    },
    buildEnd: dispose,
    closeBundle: dispose,
  };
}
