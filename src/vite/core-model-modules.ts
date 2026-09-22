import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DevelopmentModelModules } from "@warlock.js/core";
import { normalizePath, type ModuleNode, type Plugin, type ViteDevServer } from "vite";

const CODE_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const ASSET_QUERY = /[?&](?:raw|url)(?:&|$)/;

function moduleIdPath(id: string): string | undefined {
  if (id.startsWith("\0") || id.startsWith("data:")) return undefined;
  if (ASSET_QUERY.test(id)) return undefined;

  const [fileName, query] = id.split("?", 2);
  if (query !== undefined && !/^t=\d+$/.test(query)) return undefined;
  if (!CODE_MODULE_EXTENSION.test(fileName)) return undefined;

  try {
    return fileName.startsWith("file:") ? fileURLToPath(fileName) : path.resolve(fileName);
  } catch {
    return undefined;
  }
}

function versionedUrl(url: string, generation: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${generation}`;
}

function isSsrEnvironment(
  context: { environment?: { config?: { consumer?: string } } },
  ssr?: boolean,
) {
  return ssr === true || context.environment?.config?.consumer === "server";
}

function trampoline(url: string, hasDefault: boolean): string {
  const defaultExport = hasDefault ? `\nexport { default } from ${JSON.stringify(url)};` : "";
  const nativeCode = `export * from ${JSON.stringify(url)};${defaultExport}`;
  const nativeUrl = `data:text/javascript,${encodeURIComponent(nativeCode)}`;
  const proxyDefault = hasDefault ? `\nexport { default } from ${JSON.stringify(nativeUrl)};` : "";

  return `export * from ${JSON.stringify(nativeUrl)};${proxyDefault}`;
}

function invalidateWithImporters(
  server: ViteDevServer,
  file: string,
  ids: ReadonlySet<string>,
): void {
  const graph = server.environments.ssr.moduleGraph;
  const visited = new Set<ModuleNode>();
  const invalidate = (current: ModuleNode) => {
    if (visited.has(current)) return;
    visited.add(current);
    graph.invalidateModule(current, new Set(), Date.now(), true);
    for (const importer of current.importers) invalidate(importer);
  };

  for (const id of ids) {
    const module = graph.getModuleById(id);
    if (module) invalidate(module);
  }

  for (const module of graph.getModulesByFile(normalizePath(file)) ?? []) invalidate(module);
}

/**
 * Makes Vite's development SSR graph read Core-loaded model modules through
 * Node's already-live file URL, rather than through a second Vite evaluation.
 */
export function coreModelModules(registry?: DevelopmentModelModules): Plugin {
  let unsubscribe: (() => void) | undefined;
  const bridgedIdsByUrl = new Map<string, Set<string>>();

  const dispose = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  return {
    name: "warlock:core-model-modules",
    enforce: "post",
    applyToEnvironment: (environment) => environment.config.consumer === "server",
    transform(_code, id, options) {
      if (!isSsrEnvironment(this, options?.ssr)) return null;

      const absolutePath = moduleIdPath(id);
      if (!absolutePath || !registry) return null;

      const entry = registry.get(absolutePath);
      if (!entry) return null;
      if (entry.state === "removed") {
        throw new Error(`[warlock:web] Core model module was removed: ${absolutePath}`);
      }

      const liveUrl = versionedUrl(entry.url, entry.generation);
      const bridgedIds = bridgedIdsByUrl.get(entry.url) ?? new Set<string>();
      bridgedIds.add(normalizePath(absolutePath));
      bridgedIds.add(normalizePath(id));
      bridgedIdsByUrl.set(entry.url, bridgedIds);
      return { code: trampoline(liveUrl, entry.hasDefault), map: null };
    },
    configureServer(server) {
      if (!registry) return;
      unsubscribe = registry.subscribe((entry) => {
        // The entry carries Core's exact Node URL; it is also the only stable
        // path available to subscribers for a removal notification.
        if (!entry.url) return;
        invalidateWithImporters(
          server,
          fileURLToPath(entry.url),
          bridgedIdsByUrl.get(entry.url) ?? new Set(),
        );
      });
    },
    buildEnd: dispose,
    closeBundle: dispose,
  };
}
